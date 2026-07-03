export function encodeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function decodeEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Render an embedding as a JSON array string for libSQL's `vector32('[…]')`,
 * which is how vectors are inserted and compared (`vector_distance_cos`).
 */
export function embeddingToJson(vec: Float32Array | number[]): string {
  return "[" + Array.from(vec).join(",") + "]";
}
