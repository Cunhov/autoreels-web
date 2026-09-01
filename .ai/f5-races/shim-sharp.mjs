// Shim para "sharp" fora do Next em node v25 (binários pré-compilados não
// carregam). O publisher só o usa para normalização de imagens — fora do
// escopo dos testes de race (M13/M14/M11/M10/M15), que nunca tocam sharp.
export default function sharp(input) {
  return {
    async metadata() {
      return { width: 1080, height: 1920, format: "jpeg" };
    },
    async toBuffer() {
      return Buffer.isBuffer(input) ? input : Buffer.from("shim-image");
    },
    resize() {
      return this;
    },
    rotate() {
      return this;
    },
    jpeg() {
      return this;
    },
    png() {
      return this;
    },
    webp() {
      return this;
    },
    clone() {
      return this;
    },
  };
}