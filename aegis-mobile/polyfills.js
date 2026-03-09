import { Buffer } from "buffer";

global.Buffer = Buffer;

if (typeof process === "undefined") {
  global.process = { env: {} };
}
