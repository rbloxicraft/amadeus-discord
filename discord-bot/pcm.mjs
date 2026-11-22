/* Voix GPT-SoVITS → PCM 16 bits mono 48 kHz pour le micro virtuel, au fil de l'eau.

   La voix arrive en WAV « streaming » (en-tête puis PCM brut, morceau par morceau).
   Passer par ffmpeg retardait le premier son de 0,5 à 2 s (il attend d'avoir assez de
   données avant de sortir quoi que ce soit) : on lit donc le WAV ici, et on le
   rééchantillonne nous-mêmes (filtre de Lanczos, même résultat que ffmpeg à -60 dB). */

const LOBES = 8;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

function lanczos(t) {
  if (t === 0) return 1;
  if (t <= -LOBES || t >= LOBES) return 0;
  return (LOBES * Math.sin(Math.PI * t) * Math.sin(Math.PI * t / LOBES)) / (Math.PI * Math.PI * t * t);
}

class Resampler {
  constructor(inRate, outRate) {
    // position exacte en entiers : idx + frac / den (32 → 48 kHz : 3 phases seulement)
    const g = gcd(inRate, outRate);
    this.num = inRate / g;                       // avance par échantillon produit = num / den
    this.den = outRate / g;
    const scale = Math.min(1, outRate / inRate); // en sous-échantillonnage : filtre plus large
    this.half = Math.ceil(LOBES / scale);
    this.taps = [];                              // poids normalisés, un jeu par phase
    for (let f = 0; f < this.den; f++) {
      const w = new Float32Array(2 * this.half);
      let sum = 0;
      for (let k = 0; k < w.length; k++) {       // échantillon idx - half + 1 + k
        w[k] = lanczos((f / this.den + this.half - 1 - k) * scale);
        sum += w[k];
      }
      for (let k = 0; k < w.length; k++) w[k] /= sum;
      this.taps.push(w);
    }
    this.buf = new Float32Array(this.half);      // silence « avant le début »
    this.idx = this.half;                        // prochain échantillon produit : buf[idx] + frac
    this.frac = 0;
  }

  /* x : Float32Array (-1..1) → Int16Array */
  push(x) {
    const buf = new Float32Array(this.buf.length + x.length);
    buf.set(this.buf); buf.set(x, this.buf.length);
    const { half, num, den, taps } = this;
    const n = Math.max(0, Math.ceil(((buf.length - half - this.idx) * den - this.frac) / num));
    const out = new Int16Array(n);
    let idx = this.idx, frac = this.frac;
    for (let o = 0; o < n; o++) {
      const w = taps[frac];
      let acc = 0;
      for (let k = 0, i = idx - half + 1; k < w.length; k++, i++) acc += buf[i] * w[k];
      out[o] = Math.max(-32768, Math.min(32767, Math.round(acc * 32767)));
      frac += num;
      idx += Math.floor(frac / den);
      frac %= den;
    }
    const keep = idx - half + 1;
    this.buf = buf.slice(keep);
    this.idx = idx - keep;
    this.frac = frac;
    return out;
  }

  flush() { return this.push(new Float32Array(this.half)); }
}

/* Lit un WAV (PCM 16 bits) arrivant par morceaux ; onPcm(Buffer) reçoit du 48 kHz mono. */
export function wavTo48k(onPcm, outRate = 48000) {
  let head = Buffer.alloc(0), fmt = null, rs = null, rest = Buffer.alloc(0);
  const emit = (i16) => { if (i16.length) onPcm(Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength)); };
  return {
    push(chunk) {
      if (!rs) {
        head = Buffer.concat([head, chunk]);
        if (head.length < 12) return;
        if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('voix : WAV invalide');
        let p = 12;
        for (;;) {                                // blocs « fmt », « LIST »… jusqu'à « data »
          if (head.length < p + 8) return;
          const id = head.toString('ascii', p, p + 4);
          const size = head.readUInt32LE(p + 4);
          if (id === 'data') { chunk = head.subarray(p + 8); break; }   // taille ignorée (flux)
          if (head.length < p + 8 + size) return;
          if (id === 'fmt ') fmt = { format: head.readUInt16LE(p + 8), channels: head.readUInt16LE(p + 10), rate: head.readUInt32LE(p + 12), bits: head.readUInt16LE(p + 22) };
          p += 8 + size + (size & 1);
        }
        if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error('voix : WAV non géré');
        rs = new Resampler(fmt.rate, outRate);
        head = null;
      }
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const frame = 2 * fmt.channels;
      const n = Math.floor(data.length / frame);
      rest = Buffer.from(data.subarray(n * frame));
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE(i * frame + 2 * c);
        x[i] = s / fmt.channels / 32768;
      }
      emit(rs.push(x));
    },
    end() { if (rs) emit(rs.flush()); },
  };
}
