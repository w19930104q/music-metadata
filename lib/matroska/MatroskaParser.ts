import initDebug from 'debug';

import { BasicParser } from '../common/BasicParser.js';
import { EbmlIterator, ParseAction } from '../ebml/EbmlIterator.js';
import type { IElementContext, ITree } from '../ebml/types.js';
import type { AnyTagValue, ITrackInfo, IVideoTrack } from '../type.js';
import { matroskaDtd } from './MatroskaDtd.js';
import {
  type IAttachedFile,
  type IDecodedAttachedFile,
  type IDecodedTrackEntry,
  type ISeekHead,
  type ITrackEntry,
  type ITrackVideo,
  TargetType,
  TrackType
} from './types.js';

const debug = initDebug('music-metadata:parser:matroska');
const targetTypes: Readonly<Record<number, string | undefined>> = TargetType;

interface IAlbumCandidate {
  value: AnyTagValue;
  targetUIDs: string[];
  untargeted: boolean;
}

function isCompleteTrack(entry: IDecodedTrackEntry): entry is ITrackEntry {
  return (
    typeof entry.trackNumber === 'number' &&
    Number.isSafeInteger(entry.trackNumber) &&
    entry.trackNumber > 0 &&
    typeof entry.codecID === 'string' &&
    entry.codecID.length > 0 &&
    Object.values(TrackType).some(type => type === entry.trackType)
  );
}

function isCompleteFile(file: IDecodedAttachedFile): file is IAttachedFile {
  return (
    typeof file.name === 'string' &&
    typeof file.mimeType === 'string' &&
    file.data instanceof Uint8Array &&
    file.uid instanceof Uint8Array
  );
}

function videoInfo(video: ITrackVideo): IVideoTrack {
  const { flagInterlaced, ...properties } = video;
  const result: IVideoTrack = properties;
  // Matroska uses 0=undetermined, 1=interlaced, 2=progressive.
  if (flagInterlaced === 1 || flagInterlaced === 2) {
    result.flagInterlaced = flagInterlaced === 1;
  }
  return result;
}

/**
 * Extensible Binary Meta Language (EBML) parser
 * https://en.wikipedia.org/wiki/Extensible_Binary_Meta_Language
 * http://matroska.sourceforge.net/technical/specs/rfc/index.html
 *
 * WEBM VP8 AUDIO FILE
 */
export class MatroskaParser extends BasicParser {
  private tracksByUid = new Map<string, ITrackInfo>();
  private trackStatistics = new Map<string, Map<string, string>>();
  private seekHead: ISeekHead | undefined;
  private seekHeadOffset = 0;
  private selectedAudioTrackUid?: string;
  private albumCandidates: IAlbumCandidate[] = [];
  /**
   * Use index to skip multiple segment/cluster elements at once.
   * Significant performance impact
   */
  private flagUseIndexToSkipClusters = this.options.mkvUseIndex ?? false;
  /**
   * When `duration: true` and no duration from Segment Info / track statistics,
   * scan Cluster block timing to recover presentation duration.
   */
  private flagScanClusterTiming = false;
  private timecodeScaleNs = 1000000;
  private clusterTimecode = 0;
  private trackMaxEndNs = new Map<string, number>();
  private trackDefaultDuration = new Map<string, number>();
  private trackLastTimestampNs = new Map<string, number>();
  private trackMinDeltaNs = new Map<string, number>();

  public async parse(): Promise<void> {
    const containerSize = this.tokenizer.fileInfo.size ?? Number.MAX_SAFE_INTEGER;

    const attachmentMimeTypes = new WeakMap<IElementContext, string>();
    const matroskaIterator = new EbmlIterator(this.tokenizer, this.options);
    debug('Initializing DTD end MatroskaIterator');
    await matroskaIterator.iterate(matroskaDtd, containerSize, {
      // Process tags and attachments one at a time. Never assemble a Segment/root tree.
      collect: element => {
        const base = [0x114d9b74, 0x1549a966, 0x1654ae6b, 0x7373, 0x61a7].includes(element.id);
        if (this.options.duration && element.id === 0x1f43b675) {
          return true; // collect clusters for block-timing duration scan
        }
        return base;
      },
      startNext: async element => {
        switch (element.id) {
          case 0x18538067: // SeekPosition is relative to the Segment payload, not the SeekHead.
            this.seekHeadOffset = this.tokenizer.position;
            return ParseAction.ReadNext;
          case 0x1941a469: // Attachments are only used for cover pictures.
            return this.options.skipCovers ? ParseAction.IgnoreElement : ParseAction.ReadNext;
          case 0x465c: {
            // FileData
            const mimeType = element.parent && attachmentMimeTypes.get(element.parent);
            // If MIME follows FileData, retain one payload under maxMemoryAllocation
            // until AttachedFile ends, then classify it. This also works on streams.
            return mimeType !== undefined && !mimeType.startsWith('image/')
              ? ParseAction.IgnoreElement
              : ParseAction.ReadNext;
          }
          case 0x114d9b74:
            return this.flagUseIndexToSkipClusters ? ParseAction.ReadNext : ParseAction.IgnoreElement;
          case 0x63a2: // CodecPrivate is not exposed as metadata.
          case 0x6d80: // ContentEncodings
          case 0x1043a770: // Chapters are not currently exposed by this parser.
          case 0x1c53bb6b: // Cueing Data
            debug(`Skip element: name=${element.name}, id=0x${element.id.toString(16)}`);
            return ParseAction.IgnoreElement;
          case 0x1f43b675: // cluster
            if (this.options.duration && !this.metadata.format.duration) {
              this.flagScanClusterTiming = true;
              return ParseAction.ReadNext;
            }
            if (this.flagUseIndexToSkipClusters && this.seekHead) {
              const index = (this.seekHead.seek ?? []).find(
                index => index.position !== undefined && index.position + this.seekHeadOffset > this.tokenizer.position
              );
              if (index?.position !== undefined) {
                // Go to next index position
                const ignoreSize = index.position + this.seekHeadOffset - this.tokenizer.position;
                debug(`Use index to go to next position, ignoring ${ignoreSize} bytes`);
                await this.tokenizer.ignore(ignoreSize);
                return ParseAction.SkipElement;
              }
            }
            return ParseAction.IgnoreElement;
          default:
            return ParseAction.ReadNext;
        }
      },
      onElement: async event => {
        if (debug.enabled) {
          const value = event.value instanceof Uint8Array ? `${event.value.byteLength} bytes` : event.value;
          debug(`Received: name=${event.element.name}, value=${value}`);
        }
        switch (event.id) {
          case 0x4282: // docType
            this.metadata.setFormat('container', `EBML/${event.value}`);
            break;

          case 0x114d9b74:
            this.seekHead = event.value;
            break;

          case 0x1549a966:
            {
              // Info (Segment Information)
              const info = event.value;
              if (info.title !== undefined) {
                await this.addTag('segment:title', info.title);
              }
              const timecodeScale = info.timecodeScale ? info.timecodeScale : 1000000;
              this.timecodeScaleNs = timecodeScale;
              if (typeof info.duration === 'number') {
                const duration = (info.duration * timecodeScale) / 1000000000;
                if (Number.isFinite(duration) && duration > 0) {
                  this.metadata.setFormat('duration', duration);
                  this.metadata.setFormat('containerDuration', duration);
                }
              }
            }
            break;

          case 0x1654ae6b:
            {
              // tracks
              const audioTracks = event.value;
              if (audioTracks?.entries) {
                const entries = audioTracks.entries
                  .filter(entry => {
                    if (isCompleteTrack(entry)) {
                      return true;
                    }
                    this.metadata.addWarning('Ignoring Matroska track without valid TrackNumber, TrackType or CodecID');
                    return false;
                  })
                  .filter(isCompleteTrack);
                entries.forEach(entry => {
                  const stream: ITrackInfo = {
                    id: entry.trackNumber,
                    codecId: entry.codecID,
                    codecName: entry.codecName ?? entry.codecID.replace(/^[AV]_/, ''),
                    codecSettings: entry.codecSettings,
                    flagDefault: entry.flagDefault ?? true,
                    flagLacing: entry.flagLacing ?? true,
                    flagEnabled: entry.flagEnabled ?? true,
                    flagForced: entry.flagForced ?? false,
                    language: entry.languageIETF ?? entry.language ?? 'eng',
                    name: entry.name,
                    type: entry.trackType,
                    audio:
                      entry.trackType === TrackType.audio
                        ? {
                            ...entry.audio,
                            samplingFrequency: entry.audio?.samplingFrequency ?? 8000,
                            channels: entry.audio?.channels ?? 1
                          }
                        : undefined,
                    video: entry.trackType === TrackType.video && entry.video ? videoInfo(entry.video) : undefined
                  };
                  if (stream.video && entry.defaultDuration && entry.defaultDuration > 0) {
                    stream.video = { ...stream.video, frameRate: 1e9 / entry.defaultDuration };
                  }
                  if (entry.uid) {
                    const key = this.uidKey(entry.uid);
                    this.tracksByUid.set(key, stream);
                    this.trackNumberToUid.set(entry.trackNumber, key);
                    if (entry.trackType === TrackType.audio && entry.defaultDuration && entry.defaultDuration > 0) {
                      this.trackDefaultDuration.set(key, entry.defaultDuration);
                    }
                  }
                  this.metadata.addStreamInfo(stream);
                });

                const audioTrack = entries
                  .filter(entry => entry.trackType === TrackType.audio && entry.flagEnabled !== false)
                  .reduce((acc: ITrackEntry | null, cur: ITrackEntry): ITrackEntry => {
                    if (!acc) {
                      return cur;
                    }
                    const currentDefault = cur.flagDefault ?? true;
                    const previousDefault = acc.flagDefault ?? true;
                    if (currentDefault !== previousDefault) {
                      return currentDefault ? cur : acc;
                    }
                    if (cur.trackNumber < acc.trackNumber) {
                      return cur;
                    }
                    return acc;
                  }, null);

                if (audioTrack) {
                  if (audioTrack.uid) {
                    this.selectedAudioTrackUid = this.uidKey(audioTrack.uid);
                  }
                  this.metadata.setFormat('codec', audioTrack.codecID.replace(/^A_/, ''));
                  this.metadata.setFormat('hasAudio', true);
                  this.metadata.setFormat(
                    'sampleRate',
                    audioTrack.audio?.outputSamplingFrequency ?? audioTrack.audio?.samplingFrequency ?? 8000
                  );
                  this.metadata.setFormat('numberOfChannels', audioTrack.audio?.channels ?? 1);
                  if (audioTrack.audio?.bitDepth !== undefined) {
                    this.metadata.setFormat('bitsPerSample', audioTrack.audio.bitDepth);
                  }
                }
              }
            }
            break;

          case 0x7373: {
            // One Tag, released before the next sibling.
            const tag = event.value;
            const target = tag.target;
            for (const uid of target?.tagTrackUID ?? []) {
              const key = this.uidKey(uid);
              if (key !== '0') {
                const statistics = this.trackStatistics.get(key) ?? new Map<string, string>();
                for (const simpleTag of tag.simpleTags ?? []) {
                  if (simpleTag.name && typeof simpleTag.string === 'string') {
                    statistics.set(simpleTag.name.toUpperCase(), simpleTag.string);
                  }
                }
                this.trackStatistics.set(key, statistics);
              }
            }
            const targetType =
              target?.targetTypeValue !== undefined
                ? (targetTypes[target.targetTypeValue] ?? 'track')
                : (target?.targetType ?? 'track');
            const isTrackTarget = targetType.toLowerCase() === 'track';
            const targetUidKeys = (target?.tagTrackUID ?? []).map(uid => this.uidKey(uid)).filter(uid => uid !== '0');
            const selectedAudioUid = this.selectedAudioTrackUid;
            const targetsSelectedAudio = selectedAudioUid !== undefined && targetUidKeys.includes(selectedAudioUid);
            const isUntargeted = (target?.tagTrackUID ?? []).length === 0;
            for (const simpleTag of tag.simpleTags ?? []) {
              const value = simpleTag.string ?? simpleTag.binary;
              if (simpleTag.name && value !== undefined) {
                const nameUpper = simpleTag.name.toUpperCase();
                if (isTrackTarget && nameUpper === 'ALBUM') {
                  this.addNativeTag('track:ALBUM', value);
                  this.albumCandidates.push({
                    value,
                    targetUIDs: targetUidKeys,
                    untargeted: isUntargeted
                  });
                } else if (
                  isTrackTarget &&
                  (nameUpper === 'DATE' ||
                    nameUpper === 'DISC' ||
                    nameUpper === 'COMPOSER' ||
                    nameUpper === 'ALBUM_ARTIST')
                ) {
                  // Map track-level tags only when they target the selected audio track (or are untargeted).
                  // Tags targeting other tracks are preserved as native tags only.
                  if (selectedAudioUid !== undefined && !targetsSelectedAudio && !isUntargeted) {
                    this.addNativeTag(`track:${simpleTag.name}`, value);
                  } else {
                    await this.addTag(`${targetType}:${simpleTag.name}`, value);
                  }
                } else {
                  await this.addTag(`${targetType}:${simpleTag.name}`, value);
                }
              }
            }
            break;
          }

          case 0x4660: // FileMediaType
            if (event.element.parent) {
              attachmentMimeTypes.set(event.element.parent, event.value);
            }
            break;

          case 0x61a7: {
            // One AttachedFile, released before the next sibling.
            const file = event.value;
            if (file.mimeType?.startsWith('image/')) {
              if (isCompleteFile(file)) {
                await this.addTag('picture', {
                  data: file.data,
                  format: file.mimeType,
                  description: file.description,
                  name: file.name
                });
              } else {
                this.metadata.addWarning('Ignoring incomplete Matroska image attachment');
              }
            }
            break;
          }

          // Cluster block-timing duration scan (only when flagScanClusterTiming)
          case 0xe7: // ClusterTimecode
            if (this.flagScanClusterTiming) {
              this.clusterTimecode = event.value as number;
            }
            break;

          case 0xa3: // SimpleBlock
            if (this.flagScanClusterTiming) {
              this.processSimpleBlock(event.value as Uint8Array);
            }
            break;

          case 0xa0: // BlockGroup
            if (this.flagScanClusterTiming && event.value && typeof event.value === 'object') {
              this.processBlockGroup(event.value as ITree);
            }
            break;
        }
      }
    });
    this.applyTrackStatistics();
    this.applyClusterTiming();
    await this.resolveTrackAlbum();
  }

  private trackNumberToUid = new Map<number, string>();

  /**
   * Parse a SimpleBlock / Block binary payload and update the max presentation
   * end time for the referenced track. Block payload layout:
   *   TrackNumber (vint), Timestamp (int16 BE), Flags (1 byte), [lace data], Frame data
   */
  private processBlockPayload(data: Uint8Array, blockDuration?: number): void {
    if (data.length < 4) {
      return;
    }
    let pos = 0;
    // Read VINT track number: count leading zero bits to determine length
    const first = data[pos];
    let trackNumberLength = 1;
    let mask = 0x80;
    while ((first & mask) === 0) {
      ++trackNumberLength;
      mask >>= 1;
      if (trackNumberLength > 8) {
        return;
      }
    }
    if (pos + trackNumberLength + 2 > data.length) {
      return;
    }
    let trackNumber = first & (0x7f >> (trackNumberLength - 1));
    for (let i = 1; i < trackNumberLength; ++i) {
      trackNumber = (trackNumber << 8) | data[pos + i];
    }
    pos += trackNumberLength;
    // Read int16 timestamp (relative to cluster timecode)
    const timestamp = (data[pos] << 8) | data[pos + 1];
    const signedTimestamp = timestamp & 0x8000 ? timestamp - 0x10000 : timestamp;
    pos += 2;
    // Flags byte
    const flags = data[pos];
    const lacing = (flags >> 4) & 0x03;

    const uidKey = this.trackNumberToUid.get(trackNumber);
    if (uidKey === undefined) {
      return;
    }

    // Presentation time in nanoseconds
    const timecodeScale = this.timecodeScaleNs;
    const presentationNs = (this.clusterTimecode + signedTimestamp) * timecodeScale;

    // Track timestamp deltas to estimate block duration when BlockDuration is absent
    const lastTs = this.trackLastTimestampNs.get(uidKey);
    if (lastTs !== undefined) {
      const delta = presentationNs - lastTs;
      if (delta > 0) {
        const curMin = this.trackMinDeltaNs.get(uidKey);
        if (curMin === undefined || delta < curMin) {
          this.trackMinDeltaNs.set(uidKey, delta);
        }
      }
    }
    this.trackLastTimestampNs.set(uidKey, presentationNs);

    // Duration in timecode-scale units: BlockDuration > track defaultDuration > estimated delta
    let durationUnits = blockDuration;
    if (durationUnits === undefined) {
      durationUnits = this.trackDefaultDuration.get(uidKey);
    }
    if (durationUnits === undefined) {
      const minDelta = this.trackMinDeltaNs.get(uidKey);
      if (minDelta !== undefined) {
        durationUnits = minDelta / timecodeScale;
      }
    }

    const presentationEndNs = presentationNs + (durationUnits ?? 0) * timecodeScale;

    const current = this.trackMaxEndNs.get(uidKey) ?? 0;
    if (presentationEndNs > current) {
      this.trackMaxEndNs.set(uidKey, presentationEndNs);
    }

    // Track lacing for potential frame-count refinement; ignored in this scan.
    void lacing;
    void flags;
  }

  private processSimpleBlock(data: Uint8Array): void {
    this.processBlockPayload(data);
  }

  private processBlockGroup(tree: ITree): void {
    const block = tree.block;
    const blockDuration = tree.blockDuration;
    if (block instanceof Uint8Array) {
      this.processBlockPayload(block, typeof blockDuration === 'number' ? blockDuration : undefined);
    }
  }

  private applyClusterTiming(): void {
    if (!this.flagScanClusterTiming || !this.selectedAudioTrackUid) {
      return;
    }
    const maxEndNs = this.trackMaxEndNs.get(this.selectedAudioTrackUid);
    if (maxEndNs === undefined || maxEndNs <= 0) {
      return;
    }
    const duration = maxEndNs / 1e9;
    if (!this.metadata.format.duration || duration < this.metadata.format.duration) {
      this.metadata.setFormat('duration', duration);
    }
  }

  private addNativeTag(tagId: string, value: AnyTagValue): void {
    this.metadata.registerTagType('matroska');
    if (!this.metadata.native.matroska) {
      this.metadata.native.matroska = [];
    }
    this.metadata.native.matroska.push({ id: tagId, value });
  }

  private async resolveTrackAlbum(): Promise<void> {
    if (this.albumCandidates.length === 0) {
      return;
    }
    const selectedAudioUid = this.selectedAudioTrackUid;
    const targetsSelectedAudio = (candidate: IAlbumCandidate) =>
      selectedAudioUid !== undefined && candidate.targetUIDs.includes(selectedAudioUid);
    const targetsVideoOnly = (candidate: IAlbumCandidate) =>
      candidate.targetUIDs.length > 0 &&
      candidate.targetUIDs.every(uid => this.tracksByUid.get(uid)?.type === TrackType.video);
    const selected =
      this.albumCandidates.findLast(targetsSelectedAudio) ??
      this.albumCandidates.findLast(candidate => candidate.untargeted) ??
      this.albumCandidates.findLast(candidate => !targetsVideoOnly(candidate)) ??
      this.albumCandidates[this.albumCandidates.length - 1];
    if (this.metadata.common.album === undefined) {
      await this.metadata.postMap('matroska', { id: 'album', value: selected.value });
    }
  }

  private uidKey(uid: Uint8Array): string {
    return (
      Array.from(uid, byte => byte.toString(16).padStart(2, '0'))
        .join('')
        .replace(/^0+/, '') || '0'
    );
  }

  private applyTrackStatistics(): void {
    for (const [uid, tags] of this.trackStatistics) {
      const track = this.tracksByUid.get(uid);
      if (!track) {
        continue;
      }
      const duration = tags.get('DURATION')?.match(/^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/);
      if (duration) {
        const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
        if (Number.isFinite(seconds) && seconds > 0) {
          track.duration = seconds;
        }
      }
      const number = (name: string): number | undefined => {
        const value = tags.get(name);
        if (value && /^\d+$/.test(value)) {
          const result = Number(value);
          if (Number.isSafeInteger(result) && result >= 0) {
            return result;
          }
        }
        return undefined;
      };
      const bitrate = number('BPS');
      const size = number('NUMBER_OF_BYTES');
      if (bitrate !== undefined && bitrate > 0) {
        track.bitrate = bitrate;
      } else if (size !== undefined && track.duration) {
        track.bitrate = (size * 8) / track.duration;
      }
      const frames = number('NUMBER_OF_FRAMES');
      if (track.video && frames !== undefined && frames > 0 && track.duration) {
        track.video.frameRate ??= frames / track.duration;
      }
    }
  }

  private async addTag(tagId: string, value: AnyTagValue): Promise<void> {
    await this.metadata.addTag('matroska', tagId, value);
  }
}
