import sharp from 'sharp';

const colorDistance = (left: readonly number[], right: readonly number[]): number =>
  Math.sqrt(
    ((left[0] ?? 0) - (right[0] ?? 0)) ** 2
      + ((left[1] ?? 0) - (right[1] ?? 0)) ** 2
      + ((left[2] ?? 0) - (right[2] ?? 0)) ** 2,
  );

const pixelAt = (data: Uint8Array, width: number, x: number, y: number): [number, number, number] => {
  const offset = (y * width + x) * 3;
  return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
};

const matchesPixelSamples = (
  data: Uint8Array,
  samples: Array<{ x: number; y: number; color: readonly [number, number, number]; tolerance: number }>,
): boolean =>
  samples.every((sample) => colorDistance(pixelAt(data, 16, sample.x, sample.y), sample.color) <= sample.tolerance);

export const isLikelyDefaultArtistAvatarImage = async (source: sharp.Sharp): Promise<boolean> => {
  const { data, info } = await source
    .clone()
    .removeAlpha()
    .resize(16, 16, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== 16 || info.height !== 16 || info.channels < 3) {
    return false;
  }

  const qqMusicDefaultAvatarSamples = [
    { x: 1, y: 1, color: [236, 246, 238] as const, tolerance: 34 },
    { x: 8, y: 4, color: [253, 230, 206] as const, tolerance: 34 },
    { x: 5, y: 13, color: [146, 228, 187] as const, tolerance: 34 },
    { x: 11, y: 13, color: [146, 228, 187] as const, tolerance: 34 },
    { x: 8, y: 13, color: [243, 253, 247] as const, tolerance: 34 },
  ];

  const neteaseSingerSilhouetteDefaultSamples = [
    { x: 1, y: 1, color: [69, 69, 69] as const, tolerance: 22 },
    { x: 8, y: 1, color: [74, 74, 74] as const, tolerance: 22 },
    { x: 14, y: 1, color: [69, 69, 69] as const, tolerance: 22 },
    { x: 3, y: 4, color: [101, 101, 101] as const, tolerance: 24 },
    { x: 8, y: 4, color: [83, 83, 83] as const, tolerance: 22 },
    { x: 12, y: 4, color: [103, 103, 103] as const, tolerance: 24 },
    { x: 4, y: 8, color: [105, 105, 105] as const, tolerance: 24 },
    { x: 8, y: 8, color: [38, 38, 38] as const, tolerance: 18 },
    { x: 12, y: 8, color: [97, 97, 97] as const, tolerance: 24 },
    { x: 3, y: 12, color: [52, 52, 52] as const, tolerance: 20 },
    { x: 8, y: 12, color: [30, 30, 30] as const, tolerance: 16 },
    { x: 12, y: 12, color: [51, 51, 51] as const, tolerance: 20 },
    { x: 8, y: 14, color: [19, 19, 19] as const, tolerance: 14 },
  ];

  return matchesPixelSamples(data, qqMusicDefaultAvatarSamples)
    || matchesPixelSamples(data, neteaseSingerSilhouetteDefaultSamples);
};
