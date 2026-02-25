/**
 * Polyfills for React Native environment
 * Must be imported at app entry point before other imports
 */

import 'react-native-get-random-values';
import { Buffer } from 'buffer';

// Ensure Buffer.subarray maintains Buffer prototype
if (typeof Buffer.prototype.subarray !== 'function') {
  Buffer.prototype.subarray = function (begin?: number, end?: number) {
    const result = Uint8Array.prototype.subarray.call(this, begin, end);
    Object.setPrototypeOf(result, Buffer.prototype);
    return result as unknown as Buffer;
  };
}

// Make Buffer globally available
global.Buffer = global.Buffer || Buffer;

// TextEncoder/TextDecoder polyfills for SDK string encoding
// These are typically available in React Native but ensure they exist
if (typeof global.TextEncoder === 'undefined') {
  class TextEncoderPolyfill {
    encode(str: string): Uint8Array {
      const arr = [];
      for (let i = 0; i < str.length; i++) {
        let charCode = str.charCodeAt(i);
        if (charCode < 0x80) {
          arr.push(charCode);
        } else if (charCode < 0x800) {
          arr.push(0xc0 | (charCode >> 6), 0x80 | (charCode & 0x3f));
        } else if (charCode < 0xd800 || charCode >= 0xe000) {
          arr.push(
            0xe0 | (charCode >> 12),
            0x80 | ((charCode >> 6) & 0x3f),
            0x80 | (charCode & 0x3f)
          );
        } else {
          // Handle surrogate pairs
          i++;
          charCode = 0x10000 + (((charCode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
          arr.push(
            0xf0 | (charCode >> 18),
            0x80 | ((charCode >> 12) & 0x3f),
            0x80 | ((charCode >> 6) & 0x3f),
            0x80 | (charCode & 0x3f)
          );
        }
      }
      return new Uint8Array(arr);
    }
  }
  (global as any).TextEncoder = TextEncoderPolyfill;
}

if (typeof global.TextDecoder === 'undefined') {
  class TextDecoderPolyfill {
    decode(buffer: Uint8Array): string {
      let str = '';
      let i = 0;
      while (i < buffer.length) {
        const byte1 = buffer[i++];
        if (byte1 < 0x80) {
          str += String.fromCharCode(byte1);
        } else if ((byte1 & 0xe0) === 0xc0) {
          const byte2 = buffer[i++];
          str += String.fromCharCode(((byte1 & 0x1f) << 6) | (byte2 & 0x3f));
        } else if ((byte1 & 0xf0) === 0xe0) {
          const byte2 = buffer[i++];
          const byte3 = buffer[i++];
          str += String.fromCharCode(
            ((byte1 & 0x0f) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f)
          );
        } else if ((byte1 & 0xf8) === 0xf0) {
          const byte2 = buffer[i++];
          const byte3 = buffer[i++];
          const byte4 = buffer[i++];
          const codePoint =
            ((byte1 & 0x07) << 18) |
            ((byte2 & 0x3f) << 12) |
            ((byte3 & 0x3f) << 6) |
            (byte4 & 0x3f);
          // Convert to surrogate pair
          const adjusted = codePoint - 0x10000;
          str += String.fromCharCode(
            0xd800 + (adjusted >> 10),
            0xdc00 + (adjusted & 0x3ff)
          );
        }
      }
      return str;
    }
  }
  (global as any).TextDecoder = TextDecoderPolyfill;
}
