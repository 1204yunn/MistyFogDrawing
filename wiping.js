// Persistent, bounded Canvas field: RG = direction, alpha = cleared film.
export class GlassWiping {
  constructor(parameters) {
    this.parameters = parameters;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.artworkCanvas = document.createElement('canvas');
    this.artworkCtx = this.artworkCanvas.getContext('2d', { willReadFrequently: true });
    this.active = false;
    this.dirty = true;
    this.elapsed = 0;
    this.remainder = 0;
    this.hold = 0;
  }
  resize(aspect) {
    const copy = document.createElement('canvas');
    const height = Math.round(Math.min(384, 512 / Math.max(1, aspect)));
    const width = Math.max(1, Math.round(height * aspect));
    if (this.canvas.width === width && this.canvas.height === height) return;
    // Fit from the last drawing size so rotating back restores its scale.
    const scale = this.frame ? Math.min(width / this.frame.width, height / this.frame.height) : 1;
    const ratio = scale / (this.frame?.scale ?? 1);
    if (this.frame) this.frame.scale = scale;
    for (const ctx of [this.ctx, this.artworkCtx]) {
      const canvas = ctx.canvas;
      copy.width = canvas.width; copy.height = canvas.height;
      copy.getContext('2d').drawImage(canvas, 0, 0);
      canvas.width = width; canvas.height = height;
      const fittedWidth = copy.width * ratio, fittedHeight = copy.height * ratio;
      ctx.drawImage(copy, (width - fittedWidth) / 2, (height - fittedHeight) / 2, fittedWidth, fittedHeight);
    }
    this.dirty = true;
  }
  reset() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.artworkCtx.clearRect(0, 0, this.artworkCanvas.width, this.artworkCanvas.height);
    this.frame = null;
    this.active = false; this.dirty = true; this.remainder = 0; this.hold=0; this.elapsed=0;
  }
  stroke(from, to) {
    const w = this.canvas.width, h = this.canvas.height;
    const dx = (to.x-from.x)*w, dy = (to.y-from.y)*h;
    const distance = Math.hypot(dx, dy);
    const speed = Math.min(1, distance/h / Math.max(.008, (to.time-from.time)/1000) / 1.8);
    const radius = h * .033 * this.parameters.wipeRange * (1+.24*speed);
    const strength = Math.min(.94, this.parameters.wipeStrength*(.66+.18*speed));
    if (radius <= 0 || strength <= 0) return;
    if (this.frame?.width !== w || this.frame.height !== h || this.frame.scale !== 1) {
      this.frame = { width: w, height: h, scale: 1 };
    }
    const count = Math.max(1, Math.ceil(distance / Math.max(1, radius*.24)));
    const red = Math.round(128+127*dx/Math.max(distance, 1));
    const green = Math.round(128+127*dy/Math.max(distance, 1));
    // Overlapping soft, asymmetric lobes avoid a circular stamp outline.
    for (let i=1; i<=count; i++) {
      const x = (from.x+(to.x-from.x)*i/count)*w;
      const y = (from.y+(to.y-from.y)*i/count)*h;
      for (let j=0; j<3; j++) {
        const phase = x*.073+y*.051+j*2.1;
        const r = radius*(.69+.13*Math.sin(phase));
        const cx = x+Math.cos(j*2.1+phase*.12)*radius*.23;
        const cy = y+Math.sin(j*2.1+phase*.12)*radius*.23;
        const gradient = this.ctx.createRadialGradient(cx,cy,0,cx,cy,r);
        gradient.addColorStop(0, `rgba(${red},${green},0,${strength*.65})`);
        gradient.addColorStop(.48, `rgba(${red},${green},0,${strength*.48})`);
        gradient.addColorStop(1, `rgba(${red},${green},0,0)`);
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(cx-r,cy-r,r*2,r*2);
        this.artworkCtx.fillStyle = gradient;
        this.artworkCtx.fillRect(cx-r,cy-r,r*2,r*2);
      }
    }
    this.active = true; this.dirty = true;
    // Preserve every stroke until at least 20 seconds after the last input.
    this.hold = 20;
  }
  update(dt) {
    const held = Math.min(dt,this.hold);
    this.hold -= held; dt -= held;
    this.elapsed += dt;
    if (this.active && this.elapsed >= 1/20) {
      // Integer subtraction avoids the low-alpha plateau of repeated compositing.
      const decay = this.elapsed*255*this.parameters.refogSpeed/10 + this.remainder;
      const amount = Math.floor(decay);
      this.remainder = decay-amount; this.elapsed = 0;
      if (amount > 0) {
        const pixels = this.ctx.getImageData(0,0,this.canvas.width,this.canvas.height);
        this.active = false;
        for (let i=3; i<pixels.data.length; i+=4) {
          pixels.data[i] = Math.max(0,pixels.data[i]-amount);
          if (pixels.data[i]) this.active = true;
        }
        this.ctx.putImageData(pixels,0,0); this.dirty = true;
      }
    } else if (!this.active) this.elapsed = 0;
    const changed = this.dirty; this.dirty = false;
    return changed;
  }
}
