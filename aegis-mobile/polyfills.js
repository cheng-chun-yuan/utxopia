import "react-native-get-random-values";
import { Buffer } from "buffer";

global.Buffer = Buffer;

if (typeof process === "undefined") {
  global.process = { env: {} };
}
