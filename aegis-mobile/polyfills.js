import { Buffer } from "buffer";

global.Buffer = Buffer;

// Polyfill crypto.getRandomValues for React Native (Hermes)
if (typeof global.crypto === "undefined") {
  global.crypto = {};
}
if (typeof global.crypto.getRandomValues !== "function") {
  global.crypto.getRandomValues = function (array) {
    for (let i = 0; i < array.length; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
    return array;
  };
}
