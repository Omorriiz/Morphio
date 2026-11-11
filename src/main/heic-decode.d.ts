declare module 'heic-decode' {
  interface DecodedImage {
    width: number
    height: number
    data: Uint8ClampedArray
  }
  interface DecodeOptions {
    buffer: Buffer | Uint8Array
  }
  function decode(options: DecodeOptions): Promise<DecodedImage>
  export default decode
}
