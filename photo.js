import { uploadConfig } from './upload-config.js';
import { uploadArtwork } from './artwork-upload.js';
import { isYaGesture, YaHold } from './gestures.js';

function encodePng(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error('瀏覽器無法編碼 PNG。'));
  }, 'image/png'));
}

export const PHOTO_WIDTH = 1788;
export const PHOTO_HEIGHT = 1006;

let logoSource, logoBounds;
function drawPhotoLogo(ctx, logo) {
  if (!logo.naturalWidth || !logo.naturalHeight) throw new Error('Logo 尚未載入。');
  if (logoSource !== logo) {
    const mask = document.createElement('canvas');
    const width = mask.width = logo.naturalWidth;
    const height = mask.height = logo.naturalHeight;
    const maskCtx = mask.getContext('2d');
    maskCtx.drawImage(logo, 0, 0);
    const pixels = maskCtx.getImageData(0,0,width,height).data;
    let left=width, top=height, right=-1, bottom=-1;
    for (let y=0; y<height; y++) {
      for (let x=0; x<width; x++) {
        if (pixels[(y*width+x)*4+3]===0) continue;
        left=Math.min(left,x); top=Math.min(top,y);
        right=Math.max(right,x); bottom=Math.max(bottom,y);
      }
    }
    if (right<left || bottom<top) throw new Error('Logo 圖片沒有可見內容。');
    logoBounds={left,top,width:right-left+1,height:bottom-top+1};
    logoSource=logo;
  }
  const {left,top,width,height}=logoBounds;
  ctx.drawImage(logo,left,top,width,height,80,100,244,244*height/width);
}

export function copyRenderedPhoto(source, logo) {
  if (!source.width || !source.height) throw new Error('目前沒有可擷取的畫面。');
  const snapshot = document.createElement('canvas');
  snapshot.width = PHOTO_WIDTH;
  snapshot.height = PHOTO_HEIGHT;
  const ctx = snapshot.getContext('2d');
  if (!ctx) throw new Error('瀏覽器無法建立合照畫布。');
  // Copy synchronously, before the WebGL drawing buffer can be discarded.
  const scale = Math.max(PHOTO_WIDTH/source.width, PHOTO_HEIGHT/source.height);
  const width = source.width*scale, height = source.height*scale;
  ctx.drawImage(source,(PHOTO_WIDTH-width)/2,(PHOTO_HEIGHT-height)/2,width,height);
  drawPhotoLogo(ctx,logo);
  return encodePng(snapshot);
}

function downloadPng(blob, filename) {
  const link = document.createElement('a');
  if (!('download' in link)) throw new Error('此瀏覽器不支援直接下載。');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

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
  return encodePng(snapshot);
}

export class ArtworkPreview {
  constructor({ onResetPen, mask, canParticipate, capturePortrait, upload = uploadArtwork, config = uploadConfig }) {
    this.onResetPen=onResetPen; this.mask=mask;
    this.upload = upload;
    this.canParticipate = canParticipate;
    this.capturePortrait = capturePortrait;
    this.uploadConfig = config;
    this.uploadAvailable = config.uploadEnabled === true && Boolean(config.turnstileSiteKey.trim());
    this.uploadOriginAllowed = location.origin === config.allowedOrigin;
    this.stage='live'; this.generation=0;
    this.yaHold=new YaHold(); this.yaHolding=false;
    this.dialog=document.querySelector('#photo-preview');
    this.image=document.querySelector('#photo-image');
    this.notice=document.querySelector('#photo-notice');
    this.retake=document.querySelector('#photo-retake');
    this.portraitDownload=document.querySelector('#portrait-download');
    this.artworkDownload=document.querySelector('#artwork-download');
    this.downloadStatus=document.querySelector('#photo-download-status');
    this.submit = document.querySelector('#artwork-submit');
    this.consentStatus = document.querySelector('#artwork-consent-status');
    this.turnstileContainer = document.querySelector('#artwork-turnstile');
    const uploadNote = document.querySelector('#artwork-upload-note');
    uploadNote.hidden = this.uploadAvailable && this.uploadOriginAllowed;
    if (this.uploadAvailable && !this.uploadOriginAllowed) {
      uploadNote.textContent = '目前是本機或其他來源的預覽。請到 1204yunn.github.io 的正式展示頁繪畫並上傳。';
    }
    this.resetUpload();
    this.submit.addEventListener('click', () => this.submitArtwork());
    this.retake.addEventListener('click',()=>this.retry());
    this.portraitDownload.addEventListener('click',()=>this.downloadPortrait());
    this.artworkDownload.addEventListener('click',()=>this.download(this.artworkBlob,'misty-artwork.png'));
    document.querySelector('#finish-artwork').addEventListener('click',()=>this.finish());
    this.dialog.addEventListener('cancel', event=> { event.preventDefault(); this.retry(); });
    window.addEventListener('pagehide',()=>this.retry());
  }
  get blocksDrawing() { return !this.canParticipate() || this.stage!=='live' || this.yaHolding; }
  observeYa(data,videoAspect) {
    if (!this.canParticipate()) return false;
    const pose=data.landmarks ? isYaGesture(data.world) ||
      isYaGesture(data.landmarks.map(point=>({...point,y:point.y/videoAspect}))) : null;
    if (this.stage!=='live') {
      if (pose===false) this.yaHold.process(false,data.timestamp,data.hand);
      return false;
    }
    const result=this.yaHold.process(pose,data.timestamp,data.hand);
    if (result.active && !this.yaHolding) this.onResetPen();
    if (result.active) this.notice.textContent=this.yaHold.locked ? '請先放下 YA 手勢。' : '保持 YA 手勢 1.5 秒，準備拍照…';
    else if (this.yaHolding) this.notice.textContent='';
    this.yaHolding=result.active;
    if (result.trigger) {
      this.stage='countdown'; this.yaDeadline=performance.now()+3000;
      this.notice.textContent='拍照倒數 3 秒';
    }
    return result.active;
  }
  updateYa(now) {
    if (this.stage!=='countdown') return;
    const seconds=Math.ceil((this.yaDeadline-now)/1000);
    if (seconds<=0) this.finish();
    else {
      const text=`拍照倒數 ${seconds} 秒`;
      if (this.notice.textContent!==text) this.notice.textContent=text;
    }
  }
  interruptYa() {
    this.yaHold.reset();
    if (this.stage==='countdown') { this.stage='live'; this.notice.textContent='拍照倒數已中止。'; }
    else if (this.yaHolding && this.stage==='live') this.notice.textContent='';
    this.yaHolding=false;
  }
  downloadPortrait() {
    this.download(this.portraitBlob,'misty-portrait.png');
  }
  download(blob,filename) {
    if (!this.dialog.open || !blob) return;
    try {
      downloadPng(blob,filename);
      this.downloadStatus.textContent = '';
    } catch {
      this.downloadStatus.textContent = '無法下載圖片，請確認瀏覽器允許下載。';
    }
  }
  async submitArtwork() {
    if (!this.canParticipate() || !this.uploadAvailable || !this.uploadOriginAllowed || this.stage !== 'preview' || !this.dialog.open ||
        !this.artworkBlob || this.uploadState !== 'ready') return;
    if (this.artworkBlob.size > 2 * 1024 * 1024) {
      this.consentStatus.textContent = '作品超過 2 MiB 上傳限制。';
      return;
    }
    const generation = this.generation;
    const submissionId = this.submissionId ??= crypto.randomUUID();
    this.uploadAttempt = new AbortController();
    this.uploadState = 'uploading';
    this.submit.disabled = true;
    this.consentStatus.textContent = '正在進行人機驗證…';
    try {
      const receipt = await this.upload({
        blob: this.artworkBlob,
        submissionId,
        container: this.turnstileContainer,
        config: this.uploadConfig,
        signal: this.uploadAttempt.signal,
        onVerified: () => {
          if (generation === this.generation) this.consentStatus.textContent = '正在等待雲端儲存確認…';
        },
      });
      if (generation !== this.generation) return;
      if (receipt?.ok !== true || receipt.submissionId !== submissionId ||
          typeof receipt.fileId !== 'string' || !/^[\w-]+$/.test(receipt.fileId)) {
        throw new Error('Invalid Drive receipt');
      }
      this.uploadState = 'complete';
      this.consentStatus.textContent = '你的濕痕已經留下';
    } catch {
      if (generation !== this.generation) return;
      this.uploadState = 'ready';
      this.submit.disabled = !this.canParticipate();
      this.consentStatus.textContent = '未能確認上傳，作品仍在。請再按一次「確認上傳」。';
    } finally {
      if (generation === this.generation) this.uploadAttempt = null;
    }
  }
  resetUpload() {
    this.uploadState = 'ready';
    this.submit.disabled = true;
    this.consentStatus.textContent = '';
  }
  async finish() {
    if (!this.canParticipate() || this.stage==='capturing' || this.stage==='preview') return;
    this.onResetPen();
    this.yaHolding=false;
    this.stage='capturing';
    const generation=++this.generation;
    try {
      const blob=await captureArtwork(this.mask);
      if (generation!==this.generation) return;
      if (!blob) {
        this.stage='live'; this.notice.textContent='先在霧玻璃上畫下圖案，再完成作品。';
        return;
      }
      this.resetUpload();
      this.artworkBlob = blob;
      this.artworkDownload.disabled=false;
      this.notice.textContent='';
      this.stage='preview'; this.dialog.showModal(); this.retake.focus();
      this.submit.disabled = !this.uploadAvailable || !this.uploadOriginAllowed;
      this.downloadStatus.textContent='正在產生預覽圖片…';
      try {
        const portrait = await this.capturePortrait();
        if (generation!==this.generation) return;
        this.portraitBlob=portrait;
        this.imageUrl=URL.createObjectURL(portrait);
        this.image.src=this.imageUrl;
        this.image.hidden=false;
        this.portraitDownload.disabled=false;
        this.downloadStatus.textContent='';
      } catch (error) {
        if (generation!==this.generation) return;
        this.downloadStatus.textContent=error.name==='SecurityError'
          ? '瀏覽器限制擷取，無法產生預覽圖片。'
          : `無法產生預覽圖片。${error.message || ''}`;
      }
    } catch(error) {
      if (generation!==this.generation) return;
      this.releaseImage();
      console.error('Artwork export:',error); this.stage='live';
      this.notice.textContent='無法輸出圖片，請再按一次「完成作品」。';
    }
  }
  releaseImage() {
    this.uploadAttempt?.abort();
    this.uploadAttempt = null;
    this.submissionId = null;
    this.resetUpload();
    this.portraitDownload.disabled = true;
    this.artworkDownload.disabled = true;
    this.downloadStatus.textContent = '';
    this.artworkBlob = null;
    this.portraitBlob = null;
    if(this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl=null; this.image.removeAttribute('src'); this.image.hidden=true;
  }
  retry() {
    this.interruptYa();
    this.generation++;
    if (this.dialog.open) this.dialog.close();
    this.releaseImage();
    this.stage='live';
    this.onResetPen();
    this.notice.textContent='';
  }
}
