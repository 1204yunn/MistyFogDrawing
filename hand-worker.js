/* Classic worker: the CJS browser bundle needs only the exports shim.
 * Keeping a classic worker also supports the MediaPipe WASM importScripts loader.
 * No camera frames are sent outside this worker/browser. */
let landmarker;
self.onmessage = async ({data}) => {
  if (data.type==='init') {
    let phase='MediaPipe 程式';
    try {
      self.exports={}; self.module={exports:self.exports};
      importScripts('./vendor/mediapipe-0.10.21.js');
      const {FilesetResolver,HandLandmarker} = self.module.exports;
      phase='WASM 設定';
      const files = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm');
      phase='WASM 或手部模型';
      const options = {
        baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',delegate:data.delegate==='GPU' ? 'GPU' : 'CPU'},
        runningMode:'VIDEO',numHands:1,
        minHandDetectionConfidence:.4,minHandPresenceConfidence:.5,minTrackingConfidence:.5,
      };
      try {
        landmarker=await HandLandmarker.createFromOptions(files,options);
      } catch (error) {
        if (options.baseOptions.delegate==='CPU') throw error;
        options.baseOptions.delegate='CPU';
        landmarker=await HandLandmarker.createFromOptions(files,options);
      }
      self.postMessage({type:'ready',delegate:options.baseOptions.delegate});
    } catch(error) { self.postMessage({type:'error',message:`${phase}：${error.message||error}`}); }
    return;
  }
  if (data.type==='frame') {
    try {
      const started = performance.now();
      const input={timestamp:data.timestamp,sourceAt:data.sourceAt,captureMs:data.captureMs,
        workerStartedAt:performance.timeOrigin+started,
        inputWidth:data.frame.width,inputHeight:data.frame.height};
      if (performance.timeOrigin+started>data.startBy) {
        self.postMessage({type:'expired',...input});
        return;
      }
      const result=landmarker.detectForVideo(data.frame,data.timestamp);
      self.postMessage({type:'result',...input,inferenceMs:performance.now()-started,
        landmarks:result.landmarks[0]||null,world:result.worldLandmarks[0]||null,
        hand:(result.handednesses || result.handedness)?.[0]?.[0]?.categoryName||''});
    } catch(error) { self.postMessage({type:'error',message:String(error.message||error)}); }
    finally { data.frame.close?.(); }
  }
};
