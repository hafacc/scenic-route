// The tiler's zigzag varint (crates/tiler/src/binfmt.rs); unchecked, as a truncated blob is a bad deploy.

export interface Cursor {
  offset: number;
}

// Plain LEB128, multiplied rather than shifted so a value past 2^31 stays exact.
export function readUnsignedVarint(bytes: Uint8Array, cursor: Cursor): number {
  let value = 0;
  let scale = 1;
  let byte = 0;
  do {
    byte = bytes[cursor.offset];
    cursor.offset += 1;
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  return value;
}

export function unzigzag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

export function readVarint(bytes: Uint8Array, cursor: Cursor): number {
  return unzigzag(readUnsignedVarint(bytes, cursor));
}
