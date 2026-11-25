export const MAX_HAND_FRAME_AGE = 400;
const MAX_HAND_INPUT_AGE = 120;
const HAND_RESULT_TIMEOUT = 1500;

// One small video source and one in-flight frame; inference stays off the UI thread.
export class HandCamera {
  constructor({button,status,debug,canStart,onResult,onReset,onTiming}) {
    Object.assign(this,{button,status,debug,canStart,onResult,onReset,onTiming});
    if (debug) { status.hidden=false; debug.hidden=false; debug.textContent='模型未載入'; }
    this.video=document.createElement('video');
    this.video.muted=true; this.video.playsInline=true;
    this.video.setAttribute('aria-hidden','true');
    this.generation=0; this.running=false; this.loading=false;
    button.addEventListener('click',()=>this.running||this.loading ? this.stop() : this.start());
    window.addEventListener('pagehide',()=>this.stop());
    document.addEventListener('visibilitychange',()=> {
      if (document.hidden && this.running) { this.onReset(); this.setStatus('waiting'); }
    });
    this.setStatus('idle','攝影機未啟動');
  }
  setStatus(state,message) {
    const labels={
      loading:'攝影機已啟動 · 模型載入中',
      waiting:'模型已載入 · 等待攝影機影格',
      missing:'攝影機已啟動 · 尚未偵測到手部，請將手移到畫面中央並稍微靠近',
      detected:'偵測到手部',
      drawing:'食指模式 · 擦拭中',
      'model-error':'模型載入失敗',
      'inference-error':'手勢辨識中斷',
    };
    const label=labels[state];
    const text=label && message ? label+' · '+message : label || message;
    if (this.status.textContent!==text) this.status.textContent=text;
    this.status.dataset.state=state;
  }
  stop(message='攝影機已關閉',state='idle') {
    this.generation++; this.loading=false; this.running=false; this.busy=false;
    cancelAnimationFrame(this.raf); clearTimeout(this.loadTimer);
    this.video.cancelVideoFrameCallback?.(this.videoFrameCallback);
    this.cancelLoad?.(); this.cancelLoad=null;
    this.worker?.terminate(); this.worker=null;
    this.stream?.getTracks().forEach(track=>track.stop()); this.stream=null;
    this.video.pause(); this.video.srcObject=null;
    this.button.textContent='啟動攝影機'; this.button.setAttribute('aria-pressed','false');
    this.onReset(); this.setStatus(state,message);
    if (this.debug) this.debug.textContent='模型未載入';
  }
  async captureFrame(width, height) {
    if (!this.frameCanvas && typeof createImageBitmap === 'function') {
      try {
        const frame = await createImageBitmap(this.video,{resizeWidth:width,resizeHeight:height,resizeQuality:'low'});
        return {frame,transfer:[frame]};
      } catch {
        // Some browsers reject video-backed ImageBitmaps. Copy only the resized frame.
      }
    }
    if (!this.frameCanvas) this.frameCanvas=document.createElement('canvas');
    if (this.frameCanvas.width!==width) this.frameCanvas.width=width;
    if (this.frameCanvas.height!==height) this.frameCanvas.height=height;
    const context=this.frameCanvas.getContext('2d',{willReadFrequently:true});
    context.drawImage(this.video,0,0,width,height);
    const frame=context.getImageData(0,0,width,height);
    return {frame,transfer:[frame.data.buffer]};
  }
  async start() {
    if (!this.canStart()) return;
    if (!window.isSecureContext) {
      this.setStatus('idle','攝影機需要 HTTPS 或 localhost，仍可直接在玻璃上繪畫'); return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setStatus('idle','瀏覽器不支援攝影機手勢，仍可直接在玻璃上繪畫'); return;
    }
    const token=++this.generation;
    this.loading=true; this.button.textContent='取消啟動'; this.setStatus('idle','等待攝影機權限');
    if (this.debug) this.debug.textContent='模型未載入 · 等待攝影機';
    let loadingModel=false;
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:20,max:24}}});
      if (token!==this.generation) { stream.getTracks().forEach(track=>track.stop()); return; }
      this.stream=stream; this.video.srcObject=stream;
      stream.getVideoTracks()[0].addEventListener('ended',()=> { if(token===this.generation) this.stop('攝影機已中斷'); });
      await this.video.play();
      if (token!==this.generation) return;
      loadingModel=true;
      this.setStatus('loading');
      if (this.debug) this.debug.textContent='正在載入 MediaPipe、WASM 與手部模型';
      const worker=new Worker(new URL('./hand-worker.js',import.meta.url));
      this.worker=worker;
      const handOptions=new URLSearchParams(location.search);
      const requestedDelegate=handOptions.get('handDelegate')==='gpu' ? 'GPU' : 'CPU';
      const inputSize=Number(handOptions.get('handSize'));
      const fixedInputSize=[320,480,640].includes(inputSize) ? inputSize : null;
      const delegate=await new Promise((resolve,reject)=> {
        this.cancelLoad=()=>reject(new Error('cancelled'));
        this.loadTimer=setTimeout(()=>reject(new Error('模型載入逾時，請確認網路後重試')),45000);
        worker.onerror=event=>reject(new Error(event.message || '手勢 Worker 無法載入'));
        worker.onmessage=({data})=> {
          if(data.type==='ready') resolve(data.delegate);
          if(data.type==='error') reject(new Error(data.message));
        };
        worker.postMessage({type:'init',delegate:requestedDelegate});
      });
      clearTimeout(this.loadTimer); this.cancelLoad=null;
      if (token!==this.generation) return;
      if (this.debug) this.debug.textContent=`模型已載入 · ${delegate} · 等待攝影機影格`;
      const failInference=message=>{
        if (token!==this.generation) return;
        console.error('Hand Landmarker:',message);
        this.stop('請重新啟動攝影機','inference-error');
        if (this.debug) this.debug.textContent=`模型已載入 · ${message}`;
      };
      let results=0;
      let expired=0;
      worker.onerror=event=>failInference(event.message || '手勢 Worker 中斷');
      worker.onmessage=({data})=> {
        if (token!==this.generation) return;
        this.busy=false;
        if (data.type==='error') { failInference(data.message); return; }
        if (data.type!=='result' && data.type!=='expired') return;
        const previousResult=this.lastResult;
        this.lastResult=performance.now();
        const age=this.lastResult-(data.sourceAt ?? data.timestamp);
        const stale=data.type==='expired' || age>MAX_HAND_FRAME_AGE;
        if (stale) expired++;
        if (!stale) this.handVisible=Boolean(data.landmarks?.length);
        const timing=this.debug ? {receivedAt:this.lastResult,age,cadence:this.lastResult-previousResult,stale,
          inputAge:data.workerStartedAt-performance.timeOrigin-(data.sourceAt ?? data.timestamp)} : undefined;
        if (timing) this.onTiming?.(data,timing);
        if (this.debug) {
          const tip=data.landmarks?.[8];
          const coordinates=tip ? ` · 食指 ${tip.x.toFixed(2)}, ${tip.y.toFixed(2)}` : '';
          const interval=results ? `${Math.round(this.lastResult-previousResult)} ms` : '—';
          const inference=Number.isFinite(data.inferenceMs) ? `${Math.round(data.inferenceMs)} ms` : '—';
          const inputAge=Number.isFinite(timing.inputAge) ? `${Math.round(timing.inputAge)} ms` : '—';
          const pose=timing.poseMatches===undefined ? '未判定' : timing.poseMatches ? '符合' : '不符合';
          const stage=data.type==='expired' ? '推論前過期' : stale ? '回傳後過期' : '新鮮';
          this.debug.textContent=`模型已載入 · ${delegate} · 回傳影格 ${++results} · 關鍵點 ${data.landmarks?.length ?? 0}${coordinates} · 單次推論 ${inference} · 擷取至回傳 ${Math.round(this.lastResult-data.timestamp)} ms · 結果間隔 ${interval} · 辨識輸入 ${data.inputWidth} × ${data.inputHeight} · 來源影格年齡 ${Math.round(age)} ms · 過期捨棄 ${expired} 張 · 原始姿勢 ${pose} · 影格狀態 ${stage} · 推論開始時影格年齡 ${inputAge}`;
        }
        if (document.hidden || stale) {
          const reason=document.hidden ? '頁面在背景' : data.type==='expired' ? '推論前影格已過期' : '回傳時影格已過期';
          this.onReset(reason,stale && !document.hidden);
          this.setStatus(data.landmarks ? 'detected' : 'waiting','辨識影格延遲');
          return;
        }
        this.onResult(data,timing);
      };
      this.loading=false; this.running=true; this.busy=false;
      this.button.textContent='關閉攝影機'; this.button.setAttribute('aria-pressed','true');
      this.setStatus('waiting');
      this.handVisible=false;
      this.lastVideoTime=-1; this.lastFrame=0; this.lastResult=performance.now();
      const videoCallbacks=typeof this.video.requestVideoFrameCallback==='function';
      const tick=(now,metadata)=> {
        if (token!==this.generation || !this.running) return;
        if (metadata) this.videoFrameCallback=this.video.requestVideoFrameCallback(tick);
        else this.raf=requestAnimationFrame(tick);
        if (document.hidden) return;
        if (this.busy && now-this.lastFrame>5000) { failInference('等待推論影格逾時'); return; }
        if (this.busy) return;
        if (!metadata) {
          if (now-this.lastResult>HAND_RESULT_TIMEOUT) { this.onReset('暫無新辨識結果'); this.setStatus('waiting'); }
          // With video callbacks, the animation loop only watches for timeouts.
          if (videoCallbacks || now-this.lastFrame<1000/15) return;
        }
        const videoTime=metadata?.mediaTime ?? this.video.currentTime;
        if (this.video.readyState<2 || !this.video.videoWidth ||
            !this.video.videoHeight || videoTime===this.lastVideoTime) return;
        const captureStarted=performance.now();
        const sourceAt=[metadata?.captureTime,metadata?.presentationTime].find(time=>time>0 && time<=captureStarted) ?? captureStarted;
        this.lastFrame=captureStarted; this.lastVideoTime=videoTime; this.busy=true;
        // Keep more detail while looking for a hand, then reduce tracking cost.
        const maxSide=fixedInputSize ?? (this.handVisible ? 480 : 640);
        const scale=Math.min(1,maxSide/Math.max(this.video.videoWidth,this.video.videoHeight));
        const width=Math.max(1,Math.round(this.video.videoWidth*scale));
        const height=Math.max(1,Math.round(this.video.videoHeight*scale));
        this.captureFrame(width,height).then(({frame,transfer})=> {
          if(token!==this.generation) { frame.close?.(); return; }
          try {
            const captureMs=this.debug ? performance.now()-captureStarted : undefined;
            worker.postMessage({type:'frame',frame,timestamp:captureStarted,sourceAt,captureMs,
              startBy:performance.timeOrigin+sourceAt+MAX_HAND_INPUT_AGE},transfer);
          } catch (error) {
            frame.close?.();
            throw error;
          }
        }).catch(error=> { if(token===this.generation) { console.error(error); this.stop('無法擷取攝影機畫面，仍可直接在玻璃上繪畫'); } });
      };
      if (videoCallbacks) this.videoFrameCallback=this.video.requestVideoFrameCallback(tick);
      this.raf=requestAnimationFrame(tick);
    } catch(error) {
      if(token!==this.generation) return;
      console.error('Camera:',error);
      const message=loadingModel ? '請確認網路後重試' : error.name==='NotAllowedError' ? '攝影機權限未開啟' : error.name==='NotFoundError' ? '找不到攝影機' : error.name==='NotReadableError' ? '攝影機被占用' : '攝影機啟動失敗';
      this.stop(message+'，仍可直接在玻璃上繪畫',loadingModel ? 'model-error' : 'idle');
      if (loadingModel && this.debug) this.debug.textContent=`模型未載入 · ${error.message}`;
    }
  }
}
