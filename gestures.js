const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0));
export function segmentCrossesRect(a,b,rect) {
  let low=0,high=1;
  for (const [start,delta,min,max] of [[a.x,b.x-a.x,rect.left,rect.right],[a.y,b.y-a.y,rect.top,rect.bottom]]) {
    if (Math.abs(delta)<1e-8) { if(start<min || start>max) return false; }
    else {
      const t1=(min-start)/delta,t2=(max-start)/delta;
      low=Math.max(low,Math.min(t1,t2)); high=Math.min(high,Math.max(t1,t2));
      if (low>high) return false;
    }
  }
  return true;
}
function angle(a,b,c) {
  const u = [a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0)];
  const v = [c.x-b.x,c.y-b.y,(c.z||0)-(b.z||0)];
  const length = Math.hypot(...u)*Math.hypot(...v);
  return length > 1e-8 ? Math.acos(Math.max(-1,Math.min(1,u.reduce((s,n,i)=>s+n*v[i],0)/length)))*180/Math.PI : 0;
}
function matchesPose(points, ya=false) {
  if (!points || points.length!==21 || points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Number.isFinite(p.z??0))) return false;
  const palm = (distance(points[0],points[9])+distance(points[5],points[17]))/2;
  if (palm<1e-6) return false;
  const extended = (m,p,d,t) => {
    const length=distance(points[m],points[p])+distance(points[p],points[d])+distance(points[d],points[t]);
    return angle(points[m],points[p],points[d])>145
      && angle(points[p],points[d],points[t])>140
      && distance(points[m],points[t])/Math.max(length,1e-8)>.86
      && distance(points[0],points[t])>distance(points[0],points[m])+palm*.35;
  };
  const folded = (m,p,d,t) => {
    const length = distance(points[m],points[p])+distance(points[p],points[d])+distance(points[d],points[t]);
    const reach = distance(points[m],points[t])/Math.max(length,1e-8);
    return !extended(m,p,d,t) && (angle(points[m],points[p],points[d])<155 || reach<.82)
      && distance(points[0],points[t])<distance(points[0],points[p])+palm*.3;
  };
  if (ya) return extended(5,6,7,8) && extended(9,10,11,12)
    && folded(13,14,15,16) && folded(17,18,19,20);
  // Drawing can use a relaxed index as long as the other fingers stay folded.
  const indexLength = distance(points[5],points[6])+distance(points[6],points[7])+distance(points[7],points[8]);
  const pointing = angle(points[5],points[6],points[7])>125 &&
    angle(points[6],points[7],points[8])>115 &&
    distance(points[5],points[8])/Math.max(indexLength,1e-8)>.79 &&
    distance(points[0],points[8])>distance(points[0],points[5])+palm*.30;
  // Thumb deliberately unconstrained; the ring and little fingers must fold.
  return pointing && folded(9,10,11,12)
    && folded(13,14,15,16) && folded(17,18,19,20);
}
export const isOneGesture = points => matchesPose(points);
export const isYaGesture = points => matchesPose(points,true);

export class YaHold {
  constructor() { this.locked=false; this.reset(); }
  reset() { this.last=null; this.hand=''; this.elapsed=0; this.missing=false; }
  process(ya,time,hand='') {
    if (ya===null && this.last!==null && time>=this.last && time-this.last<=200) {
      this.missing=true;
      return {active:true,trigger:false};
    }
    if (!ya || !Number.isFinite(time)) {
      this.reset();
      if (ya===false) this.locked=false;
      return {active:false,trigger:false};
    }
    if (this.last!==null && (time<=this.last || time-this.last>250 || hand!==this.hand)) this.reset();
    if (this.last!==null && !this.missing) this.elapsed+=time-this.last;
    this.last=time; this.hand=hand; this.missing=false;
    const trigger=!this.locked && this.elapsed>=1500;
    if (trigger) this.locked=true;
    return {active:true,trigger};
  }
}

export class GesturePen {
  constructor(normalGap = 250) { this.normalGap=normalGap; this.reset(); }
  reset() {
    this.raw=null; this.target=null; this.rendered=null;
    this.validFrames=0; this.hand=''; this.resumeAfterLoss=false;
  }
  process(landmarks,world,time,hand='',imageLandmarks=landmarks,
      poseMatches=isOneGesture(world) || isOneGesture(imageLandmarks), receivedAt=time) {
    if (!landmarks || !poseMatches) {
      const reason=landmarks ? 'pose' : 'tracking-loss';
      return this.loseTracking(landmarks ? 'detected' : 'missing',reason);
    }
    const tip = landmarks[8];
    const raw = {x:1-tip.x,y:tip.y,time,receivedAt}; // Mirrored front-facing camera, no second CSS flip.
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y) || raw.x<0 || raw.x>1 || raw.y<0 || raw.y>1) {
      return this.loseTracking('detected','outside');
    }
    const gap = this.raw ? time-this.raw.time : 0;
    const jump = this.raw ? Math.hypot(raw.x-this.raw.x,raw.y-this.raw.y) : 0;
    const strokeDistance = this.rendered ? Math.hypot(raw.x-this.rendered.x,raw.y-this.rendered.y) : 0;
    const deliveryGap = this.raw ? receivedAt-this.raw.receivedAt : 0;
    const motion = Math.max(jump,strokeDistance);
    // Older samples may connect only across a short distance on a known hand.
    const sparse = Math.max(gap,deliveryGap)>this.normalGap;
    const restart = this.raw && (
      this.hand!==hand ? 'hand-change' :
      gap<=0 || deliveryGap<0 || Math.max(gap,deliveryGap)>750 ? 'sample-gap' :
      motion>.14 || jump>.025+2*gap/1000 ? 'position-jump' :
      sparse && !hand ? 'uncertain-hand' :
      sparse && motion>.065 ? 'sparse-motion' : ''
    );
    const resume=this.resumeAfterLoss;
    if (restart) this.reset();
    this.resumeAfterLoss=false;
    this.hand=hand; this.raw=raw; this.validFrames++;
    // A restart clears the old anchor, but this valid sample can already make a dot.
    if (this.validFrames<2 && !restart && !resume) return {state:'detected',reason:'stabilizing'};
    if (!this.target || Math.hypot(raw.x-this.target.x,raw.y-this.target.y)>=.0018) {
      this.target=raw;
      return {state:'drawing',point:raw,reason:restart || undefined,rejected:restart || undefined};
    }
    return {state:'drawing',point:this.target,reason:'stationary'};
  }
  loseTracking(state,reason) {
    const hadAnchor=Boolean(this.target);
    const resume=hadAnchor || this.resumeAfterLoss;
    this.reset();
    this.resumeAfterLoss=resume;
    return {state,reason,rejected:hadAnchor ? reason : undefined};
  }
  advance(now) {
    if (!this.target || this.rendered?.time===this.target.time) return null;
    const last=this.rendered;
    // GlassWiping fills the entire segment, just as it does for mouse input.
    const point=this.target;
    if (now<point.receivedAt) return null;
    this.rendered=point;
    return {from:last || point,point};
  }
}
