/**
 * 按序探测候选 MIME，选择浏览器首个声明支持的类型。
 * MediaRecorder.isTypeSupported 在极少数实现上可能抛错，按“不支持”处理。
 */
export const CODEC_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

export interface MediaRecorderConstructorLike {
  isTypeSupported(type: string): boolean;
}

export function pickSupportedMimeType(
  MediaRecorderImpl: MediaRecorderConstructorLike
): string | null {
  for (const candidate of CODEC_CANDIDATES) {
    try {
      if (MediaRecorderImpl.isTypeSupported(candidate)) {
        return candidate;
      }
    } catch {
      // 该类型视为不支持，继续探测下一个。
    }
  }
  return null;
}
