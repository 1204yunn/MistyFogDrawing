import { isYaGesture, YaHold } from './gestures.js';

export function captureArtwork(mask) {
  const pixels = mask.getContext('2d').getImageData(0, 0, mask.width, mask.height).data;
  if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) return null;
  const snapshot = document.createElement('canvas');
  snapshot.width = mask.width; snapshot.height = mask.height;
  const ctx = snapshot.getContext('2d');
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, snapshot.width, snapshot.height);
  return new Promise((resolve, reject) => snapshot.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error('PNG 編碼失敗'));
  }, 'image/png'));
}

export class ArtworkPreview {
  constructor({ onResetPen, mask }) {
    this.onResetPen=onResetPen; this.mask=mask;
    this.hold=new YaHold(); this.stage='live'; this.holding=false; this.generation=0;
    this.countdown=document.querySelector('#photo-countdown');
    this.dialog=document.querySelector('#photo-preview');
    this.image=document.querySelector('#photo-image');
    this.notice=document.querySelector('#photo-notice');
    this.retake=document.querySelector('#photo-retake');
    this.download=document.querySelector('#artwork-download');
    this.retake.addEventListener('click',()=>this.retry());
    document.querySelector('#finish-artwork').addEventListener('click',()=>this.finish());
    this.dialog.addEventListener('cancel', event=> { event.preventDefault(); this.retry(); });
    document.addEventListener('visibilitychange',()=> { if(document.hidden) this.interrupt(); });
    window.addEventListener('pagehide',()=>this.retry());
  }
  get blocksDrawing() { return this.holding || this.stage!=='live'; }
  observe(data, ready) {
    const ya=data.landmarks ? isYaGesture(data.world || data.landmarks) : null;
    // A release still unlocks the gesture during preview.
    if (this.stage!=='live') {
      if (this.stage==='preview' && ya===false) this.hold.process(false,data.timestamp,data.hand);
      else this.hold.reset();
      return true;
    }
    const result=this.hold.process(ready ? ya : false,data.timestamp,data.hand);
    const wasHolding=this.holding;
    this.progress=result.progress || 0;
    this.holding=result.active;
    if (result.active) {
      this.onResetPen();
      this.notice.textContent=this.hold.locked ? '請先放下 YA 手勢，再重新舉起。' : '保持 YA 手勢 1.5 秒，準備完成作品…';
      if (result.trigger) {
        this.stage='countdown'; this.deadline=performance.now()+3000;
        this.countdown.textContent='3'; this.countdown.hidden=false;
        this.notice.textContent='';
      }
    } else if (wasHolding) this.notice.textContent='';
    return result.active;
  }
  interrupt() {
    const wasBlocking=this.blocksDrawing;
    this.hold.reset(); this.holding=false;
    if (wasBlocking) this.onResetPen();
    if (this.stage==='live') this.notice.textContent='';
    if (this.stage==='countdown') {
      this.generation++; this.stage='live'; this.countdown.hidden=true;
      this.notice.textContent='倒數中止，可按「完成作品」或重新比 YA。';
    }
  }
  update(now, ready) {
    if (this.stage!=='countdown') return;
    if (!ready) { this.interrupt(); return; }
    const remaining=this.deadline-now;
    if (remaining>0) { this.countdown.textContent=String(Math.ceil(remaining/1000)); return; }
    this.finish();
  }
  async finish() {
    if (this.stage==='capturing' || this.stage==='preview') return;
    this.onResetPen();
    this.countdown.hidden=true; this.stage='capturing'; this.holding=false;
    const generation=++this.generation;
    try {
      const blob=await captureArtwork(this.mask);
      if (generation!==this.generation) return;
      if (!blob) {
        this.stage='live'; this.notice.textContent='先在霧玻璃上畫下圖案，再完成作品。';
        return;
      }
      this.imageUrl=URL.createObjectURL(blob);
      this.image.src=this.download.href=this.imageUrl;
      this.notice.textContent='';
      this.stage='preview'; this.dialog.showModal(); this.retake.focus();
    } catch(error) {
      if (generation!==this.generation) return;
      this.releaseImage();
      console.error('Artwork export:',error); this.stage='live';
      this.notice.textContent='無法輸出圖片，請再按一次「完成作品」。';
    }
  }
  releaseImage() {
    if(this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl=null; this.image.removeAttribute('src');
    this.download.removeAttribute('href');
  }
  retry() {
    this.generation++;
    if (this.dialog.open) this.dialog.close();
    this.releaseImage();
    this.stage='live'; this.holding=false;
    this.hold.reset(); this.onResetPen(); this.countdown.hidden=true;
    this.notice.textContent='';
  }
}
