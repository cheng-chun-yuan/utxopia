import RNFS from "react-native-fs";
import { Platform } from "react-native";

const R2_BASE = "https://circuits.aegis.xyz/groth16";

const BUNDLED_CIRCUITS = new Set([
  "joinsplit_1x1",
  "joinsplit_1x2",
  "joinsplit_1x3",
  "joinsplit_1x4",
  "joinsplit_2x1",
  "joinsplit_2x2",
  "joinsplit_2x3",
  "joinsplit_3x1",
  "joinsplit_3x2",
  "joinsplit_4x1",
]);

export async function resolveZkeyPath(
  circuitName: string,
  onProgress?: (progress: number) => void,
): Promise<string> {
  const fileName = `${circuitName}.zkey`;
  const docPath = `${RNFS.DocumentDirectoryPath}/${fileName}`;

  if (await RNFS.exists(docPath)) return docPath;

  if (BUNDLED_CIRCUITS.has(circuitName)) {
    if (Platform.OS === "android") {
      await RNFS.copyFileAssets(`custom/${fileName}`, docPath);
    } else {
      await RNFS.copyFile(`${RNFS.MainBundlePath}/${fileName}`, docPath);
    }
    return docPath;
  }

  // On-demand download from Cloudflare R2
  const url = `${R2_BASE}/${circuitName}/${fileName}`;
  const download = RNFS.downloadFile({
    fromUrl: url,
    toFile: docPath,
    progress: (res) => {
      if (onProgress && res.contentLength > 0) {
        onProgress(res.bytesWritten / res.contentLength);
      }
    },
  });

  const result = await download.promise;
  if (result.statusCode !== 200) {
    await RNFS.unlink(docPath).catch(() => {});
    throw new Error(
      `Failed to download circuit ${circuitName}: HTTP ${result.statusCode}`,
    );
  }

  return docPath;
}

export function isBundledCircuit(circuitName: string): boolean {
  return BUNDLED_CIRCUITS.has(circuitName);
}
