import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const wrap = a => { while(a>Math.PI)a-=2*Math.PI; while(a<-Math.PI)a+=2*Math.PI; return a; };

const PROFILES = {
  sprint: { file:'track_full.json', closed:true, laps:1, target:6, weights:{track:6,head:2.5,soft:4}, hint:'Fastest single lap; balanced tracking and apex use.' },
  trackdrive: { file:'track_full.json', closed:true, laps:11, target:6, weights:{track:6,head:2.5,soft:5}, hint:'One learning lap + 10 scored laps; consistency and smooth corridor use.' },
  skidpad: { file:'skidpad.json', closed:true, laps:2, target:5, weights:{track:8,head:4,soft:6}, hint:'Figure-of-eight: minimise lateral error and steering oscillation.' },
  acceleration: { file:'acceleration.json', closed:false, laps:1, target:14, weights:{track:2,head:1,soft:8}, hint:'Straight-line peak speed, full brake into the orange stop box.' },
};

const state = {
  mode:'pp', competition:'sprint', view:'chase', playing:true,
  track:null, path:[], length:0, closed:true, laps:1,
  car:{x:0,y:0,h:0,v:0}, steer:0, targetSpeed:6,
  weights:{track:6,head:2.5,soft:4}, horizon:0.6, nTents:15,
  trail:[], history:[], tentacles:[], selected:-1, parts:null,
  t:0, lap:0, round:1, coneHits:0, finished:false,
  manual:{thr:0,brk:0,left:0,right:0}, last:{thr:0,brk:0,gear:4,drs:0},
  f1:null, fly:null, lastAct:null, idx:0, cte:0, he:0,
};

let scene, camera, renderer, carGroup, bodyMesh, noseMesh, wheelMeshes=[], cockpit, steerWheel;
let worldGroup, tentGroup, trailLine, coneMeshes=[], pathCurve;
let S=0.11, CX=0, CY=0;
const sceneEl=$('three'), graphEl=$('graph');
const gctx=graphEl.getContext('2d');

// ------------------------------------------------------------------ helpers
function w2v(p, y=0.02) { return new THREE.Vector3((p[0]-CX)*S, y, (p[1]-CY)*S); }
function nearest(x,y,hint=-1) {
  const n=state.path.length; let best=hint>=0?hint:0, bd=Infinity;
  if(hint<0){ for(let i=0;i<n;i++){const dx=state.path[i][0]-x,dy=state.path[i][1]-y,d=dx*dx+dy*dy;if(d<bd){bd=d;best=i;}} }
  else { for(let k=-18;k<=18;k++){const i=(hint+k+n)%n,dx=state.path[i][0]-x,dy=state.path[i][1]-y,d=dx*dx+dy*dy;if(d<bd){bd=d;best=i;}} }
  return best;
}
function pathYaw(i) { const n=state.path.length,a=state.path[(i-1+n)%n],b=state.path[(i+1)%n]; return Math.atan2(b[1]-a[1],b[0]-a[0]); }
function curvAt(i) {
  const n=state.path.length,a=state.path[(i-1+n)%n],b=state.path[i],c=state.path[(i+1)%n];
  const ab=[b[0]-a[0],b[1]-a[1]],bc=[c[0]-b[0],c[1]-b[1]];
  const la=Math.hypot(...ab),lb=Math.hypot(...bc),lc=Math.hypot(c[0]-a[0],c[1]-a[1]);
  return la*lb*lc<1e-9?0:2*Math.abs(ab[0]*bc[1]-ab[1]*bc[0])/(la*lb*lc);
}

// ------------------------------------------------------------------ scene
function initScene() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a1420, 0.018);
  camera = new THREE.PerspectiveCamera(60, 1, 0.05, 200);
  renderer = new THREE.WebGLRenderer({canvas:sceneEl, antialias:true, alpha:false});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // gradient sky
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(80, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite:false,
      vertexShader:`varying vec3 vP; void main(){vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader:`varying vec3 vP; void main(){ float h=clamp(normalize(vP).y*.5+.5,0.0,1.0); vec3 top=vec3(.08,.22,.42), bot=vec3(.02,.04,.08); gl_FragColor=vec4(mix(bot,top,pow(h,.7)),1.0); }`
    }));
  scene.add(sky);

  scene.add(new THREE.HemisphereLight(0xa9c8ff, 0x1a2418, 1.4));
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.0); sun.position.set(10,20,8); scene.add(sun);
  const rim = new THREE.PointLight(0x22e0ff, 30, 40); rim.position.set(-8,5,-8); scene.add(rim);

  // ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(90,90),
    new THREE.MeshStandardMaterial({color:0x111b18, roughness:.98, metalness:0}));
  ground.rotation.x = -Math.PI/2; ground.position.y = -0.01; scene.add(ground);
  const grid = new THREE.GridHelper(90,90,0x263d4d,0x16232f); grid.position.y=0; scene.add(grid);

  worldGroup = new THREE.Group(); scene.add(worldGroup);
  tentGroup = new THREE.Group(); scene.add(tentGroup);
  buildCar();
  resize(); animate();
}

function buildCar() {
  carGroup = new THREE.Group(); scene.add(carGroup);
  const mat = new THREE.MeshStandardMaterial({color:0xff6a00, metalness:.35, roughness:.35, emissive:0x351000, emissiveIntensity:.8});
  bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(1.0,0.22,1.9), mat); bodyMesh.position.y=0.24; carGroup.add(bodyMesh);
  noseMesh = new THREE.Mesh(new THREE.ConeGeometry(.28,.55,4), new THREE.MeshStandardMaterial({color:0xffd166,emissive:0x442200}));
  noseMesh.rotation.x=Math.PI/2; noseMesh.position.set(0,.24,1.15); carGroup.add(noseMesh);
  const wheelGeo = new THREE.CylinderGeometry(.22,.22,.14,14);
  const wheelMat = new THREE.MeshStandardMaterial({color:0x101216, roughness:.9});
  for (const [x,z] of [[-.55,.65],[.55,.65],[-.55,-.65],[.55,-.65]]) {
    const w = new THREE.Mesh(wheelGeo,wheelMat); w.rotation.z=Math.PI/2; w.position.set(x,.18,z); carGroup.add(w); wheelMeshes.push(w);
  }
  cockpit = new THREE.Group(); carGroup.add(cockpit);
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.2,.06,.28), new THREE.MeshStandardMaterial({color:0x0b0e15, roughness:.8}));
  dash.position.set(0,.52,.62); cockpit.add(dash);
  steerWheel = new THREE.Mesh(new THREE.TorusGeometry(.11,.022,8,24), new THREE.MeshStandardMaterial({color:0xdedede, metalness:.5, roughness:.3}));
  steerWheel.position.set(0,.52,.52); cockpit.add(steerWheel);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(.04,.04,.03,12), new THREE.MeshStandardMaterial({color:0x222833}));
  hub.rotation.x=Math.PI/2; hub.position.set(0,.52,.54); cockpit.add(hub);
  cockpit.visible=false;
}

function buildWorld(track) {
  worldGroup.clear(); coneMeshes=[];
  state.track=track; state.path=track.raceline;
  const pts=track.raceline;
  CX=pts.reduce((s,p)=>s+p[0],0)/pts.length; CY=pts.reduce((s,p)=>s+p[1],0)/pts.length;
  state.length=pts.reduce((s,p,i)=>s+Math.hypot(pts[(i+1)%pts.length][0]-p[0],pts[(i+1)%pts.length][1]-p[1]),0);
  pathCurve=new THREE.CatmullRomCurve3(pts.map(p=>w2v(p)), state.closed, 'catmullrom', .08);

  const tube=new THREE.Mesh(new THREE.TubeGeometry(pathCurve, 500, .055, 8, state.closed),
    new THREE.MeshStandardMaterial({color:0x0a3340, emissive:0x22e0ff, emissiveIntensity:.55, roughness:.5}));
  tube.position.y=.02; worldGroup.add(tube);

  const line = (arr,color,width=1,dash=null,y=.03) => {
    if(!arr || arr.length<2) return;
    const g=new THREE.BufferGeometry().setFromPoints(arr.map(p=>w2v(p,y)));
    const m=dash?new THREE.LineDashedMaterial({color,dashSize:dash[0],gapSize:dash[1],transparent:true,opacity:.75}):new THREE.LineBasicMaterial({color,transparent:true,opacity:.75});
    const l=new THREE.Line(g,m); if(dash) l.computeLineDistances(); worldGroup.add(l);
  };
  line(track.centerline,0x6d7890,1,[.25,.18]);
  line(track.boundaries.blue,0x2c6bff,2);
  line(track.boundaries.yellow,0xe0b000,2);
  line(track.raceline,0x22e0ff,3);
  line(track.softLeft,0xff9900,1,[.2,.15]);
  line(track.softRight,0xff9900,1,[.2,.15]);

  // gates
  for(const g of track.gates||[]) {
    const a=w2v([g[0],g[1]],.06), b=w2v([g[2],g[3]],.06);
    const geo=new THREE.BufferGeometry().setFromPoints([a,b]);
    worldGroup.add(new THREE.Line(geo,new THREE.LineBasicMaterial({color:0x2ca02c,transparent:true,opacity:.55})));
  }
  // cones
  const cg=new THREE.ConeGeometry(.075,.26,10);
  for(const c of track.cones||[]) {
    if(c[0]==='car_start'||c[0]==='orange'||c[0]==='big_orange') continue;
    const col=c[0]==='blue'?0x2c6bff:0xe0b000;
    const m=new THREE.Mesh(cg,new THREE.MeshStandardMaterial({color:col,emissive:col,emissiveIntensity:.25}));
    m.position.copy(w2v([c[1],c[2]],.13)); worldGroup.add(m);
    coneMeshes.push({mesh:m,x:c[1],y:c[2],hit:false,base:col});
  }
  // least-action vectors
  for(const v of track.vectors||[]) {
    const dir=new THREE.Vector3(v[2],0,v[3]).normalize();
    const arrow=new THREE.ArrowHelper(dir,w2v([v[0],v[1]],.18),.55,0x22c55e,.16,.09);
    worldGroup.add(arrow);
  }
  // stop box
  if(track.stopbox && track.stopbox.length>=8) {
    const box=[[0,1],[2,3],[4,5],[6,7],[0,1]].map(([a,b])=>w2v([track.stopbox[a],track.stopbox[b]],.04));
    worldGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(box),new THREE.LineBasicMaterial({color:0xff7a00})));
  }
  resetRound(true);
}

// ------------------------------------------------------------------ controllers
function ppSteer(idx) {
  const n=state.path.length, step=Math.max(5,Math.round(1.5/Math.max(.03,state.length/n)));
  const t=state.path[(idx+step)%n];
  const alpha=wrap(Math.atan2(t[1]-state.car.y,t[0]-state.car.x)-state.car.h);
  return clamp(Math.atan2(2*1.53*Math.sin(alpha),1.5),-.42,.42);
}
function stanleySteer(idx) {
  const n=state.path.length,p=state.path[idx],a=state.path[(idx-1+n)%n],b=state.path[(idx+1)%n];
  let tx=b[0]-a[0],ty=b[1]-a[1]; const l=Math.hypot(tx,ty)||1; tx/=l;ty/=l;
  const cte=tx*(state.car.y-p[1])-ty*(state.car.x-p[0]);
  const he=wrap(Math.atan2(ty,tx)-state.car.h);
  return clamp(he-Math.atan2(.9*cte,Math.max(.2,state.car.v)+.5),-.42,.42);
}
function evaluateArc(steer,dt=.1) {
  const steps=Math.max(4,Math.round(state.horizon/dt)); let x=state.car.x,y=state.car.y,h=state.car.h,idx=state.idx;
  let ct=0,ch=0,cs=0,cte=0,he=0; const pts=[];
  for(let j=0;j<steps;j++) {
    h+=state.car.v/1.53*Math.tan(steer)*dt; x+=state.car.v*Math.cos(h)*dt; y+=state.car.v*Math.sin(h)*dt;
    pts.push([x,y]); idx=nearest(x,y,idx);
    const n=state.path.length,a=state.path[(idx-1+n)%n],b=state.path[(idx+1)%n];
    let tx=b[0]-a[0],ty=b[1]-a[1]; const l=Math.hypot(tx,ty)||1;tx/=l;ty/=l;
    cte=tx*(y-state.path[idx][1])-ty*(x-state.path[idx][0]); he=wrap(Math.atan2(ty,tx)-h);
    ct+=cte*cte; ch+=he*he; cs+=Math.max(0,Math.abs(cte)-.72*1.8)**2;
  }
  const comfort=steer*steer+.5*(steer-state.steer)**2;
  const parts={track:state.weights.track*ct/steps,head:state.weights.head*ch/steps,comfort:.2*comfort,soft:state.weights.soft*cs/steps};
  return {steer,pts,total:parts.track+parts.head+parts.comfort+parts.soft,cte,he,parts};
}
function mpcSteer() {
  const n=state.nTents,max=.42,arcs=[];
  for(let k=0;k<n;k++) arcs.push(evaluateArc(-max+2*max*k/(n-1)));
  let best=0; for(let k=1;k<arcs.length;k++) if(arcs[k].total<arcs[best].total) best=k;
  state.tentacles=arcs; state.selected=best; state.parts=arcs[best].parts;
  return arcs[best].steer;
}
function f1Policy(idx,accel) {
  if(!state.f1) return {a:accel,steer:ppSteer(idx)};
  const p=state.path[idx],b=state.path[(idx+1)%state.path.length];
  const yaw=Math.atan2(b[1]-p[1],b[0]-p[0]),k=curvAt(idx);
  const f=[state.car.v/350,accel/50,k*20,state.car.v*state.car.v*k/50,state.car.v*k*10,state.last.thr/100,state.last.brk/100,state.last.gear/8,state.last.drs];
  const z=f.map((v,i)=>(v-state.f1.mu[i])/state.f1.sd[i]);
  const h=state.f1.b1.map((bb,i)=>Math.tanh(bb+state.f1.W1.reduce((s,row,j)=>s+row[i]*z[j],0)));
  const out=state.f1.W2.map((row,i)=>row.reduce((s,w,j)=>s+w*h[j],0)+state.f1.b2[i]);
  const thr=1/(1+Math.exp(-out[0]))*100, brk=1/(1+Math.exp(-out[1]))*100, st=Math.tanh(out[2])*.5;
  state.last.thr=thr; state.last.brk=brk;
  return {a:clamp(thr/100*4.5-brk/100*10,-10,4.5),steer:clamp(.35*st+.65*ppSteer(idx),-.42,.42)};
}
function flySteer(idx) {
  if(!state.fly) return ppSteer(idx);
  const n=state.path.length,p=state.path[idx],a=state.path[(idx-1+n)%n],b=state.path[(idx+1)%n];
  let tx=b[0]-a[0],ty=b[1]-a[1]; const l=Math.hypot(tx,ty)||1;tx/=l;ty/=l;
  const cte=tx*(state.car.y-p[1])-ty*(state.car.x-p[0]),he=wrap(Math.atan2(ty,tx)-state.car.h);
  const s=[cte/1.5,he/.5,0,he/2*5,state.steer/.4,1];
  const k=state.fly.W.map((row,i)=>Math.tanh(row.reduce((z,w,j)=>z+w*s[j],0)+state.fly.b[i]));
  let y=state.fly.Wout[state.fly.Wout.length-1];
  for(let i=0;i<k.length;i++) y+=state.fly.Wout[i]*k[i];
  for(let i=0;i<6;i++) y+=state.fly.Wout[k.length+i]*s[i];
  return clamp(.65*y+.35*ppSteer(idx),-.42,.42);
}

// ------------------------------------------------------------------ actuator/physics
function actuator(speedCmd,accel,steer) {
  const deg=clamp(steer*180/Math.PI,-24,24); let torque=0,rpm=-1,brake=0,mode='NEUTRAL';
  if(speedCmd>0){rpm=Math.min(4000,speedCmd*60/(2*Math.PI*.253));torque=50;mode='SPEED';}
  else if(accel>0){torque=clamp(300*.253*Math.abs(accel+.5)/2,0,195);mode='TORQUE';}
  else if(accel===0){mode='NEUTRAL';}
  else if(accel>-5){mode='ENGINE BRAKE';}
  else {brake=clamp(-accel/10*100,0,100);mode='BRAKE';}
  return {speedCmd,accel,steerDeg:deg,torque,rpm,brake,mode};
}

function step(dt) {
  const idx=nearest(state.car.x,state.car.y,state.idx); state.idx=idx;
  const k=curvAt(idx), vlim=Math.min(state.targetSpeed,Math.sqrt(1.4*9.81/Math.max(k,1e-4)));
  let target=vlim, steerCmd=0, accel=0, speedCmd=target;
  if(state.mode==='manual') {
    speedCmd=0; accel=state.manual.thr*4.5-state.manual.brk*10;
    steerCmd=(state.manual.left?1:0)*.35-(state.manual.right?1:0)*.35;
    state.last.thr=state.manual.thr*100; state.last.brk=state.manual.brk*100;
  } else {
    accel=clamp(8.8*(target-state.car.v),-10,4.5);
    if(state.mode==='pp') steerCmd=ppSteer(idx);
    else if(state.mode==='stanley') steerCmd=stanleySteer(idx);
    else if(state.mode==='mpc') steerCmd=mpcSteer();
    else if(state.mode==='f1'){const f=f1Policy(idx,accel);accel=f.a;steerCmd=f.steer;}
    else if(state.mode==='fly') steerCmd=flySteer(idx);
    if(state.mode!=='f1'){state.last.thr=Math.max(0,accel)/4.5*100;state.last.brk=Math.max(0,-accel)/10*100;}
  }
  const maxStep=.6*dt; state.steer+=clamp(steerCmd-state.steer,-maxStep,maxStep); state.steer=clamp(state.steer,-24*Math.PI/180,24*Math.PI/180);
  const act=actuator(speedCmd,accel,state.steer); state.lastAct=act;
  let aEff=accel;
  if(act.mode==='SPEED') aEff=clamp(8.8*(act.rpm*2*Math.PI*.253/60-state.car.v),-10,4.5);
  else if(act.mode==='TORQUE') aEff=2*act.torque/(300*.253)-.5;
  else if(act.mode==='BRAKE') aEff=-act.brake/100*10;
  else if(act.mode==='NEUTRAL') aEff=0;
  state.car.v=clamp(state.car.v+aEff*dt,0,20);
  state.car.x+=state.car.v*Math.cos(state.car.h)*dt; state.car.y+=state.car.v*Math.sin(state.car.h)*dt;
  state.car.h=wrap(state.car.h+state.car.v/1.53*Math.tan(state.steer)*dt);
  state.t+=state.car.v*dt/Math.max(1,state.length);
  checkCones();
  if(state.t>=1) endRound();
  const p=state.path[idx],n=state.path.length,a=state.path[(idx-1+n)%n],b=state.path[(idx+1)%n];
  let tx=b[0]-a[0],ty=b[1]-a[1]; const l=Math.hypot(tx,ty)||1;tx/=l;ty/=l;
  state.cte=tx*(state.car.y-p[1])-ty*(state.car.x-p[0]); state.he=wrap(Math.atan2(ty,tx)-state.car.h);
  state.trail.push([state.car.x,state.car.y]); if(state.trail.length>1000) state.trail.shift();
  state.history.push({t:state.t*state.length,cte:state.cte,v:state.car.v,brake:act.brake}); if(state.history.length>420) state.history.shift();
}
function checkCones() {
  for(const c of coneMeshes) {
    if(c.hit) continue;
    if(Math.hypot(c.x-state.car.x,c.y-state.car.y)<.55) {
      c.hit=true; state.coneHits++; c.mesh.material.color.setHex(0xff2222); c.mesh.material.emissive.setHex(0x441111);
    }
  }
}
function endRound() {
  state.round++; state.lap++;
  if(state.competition==='sprint'||state.competition==='skidpad'||state.competition==='trackdrive') {
    state.t=0; state.coneHits=0;
    for(const c of coneMeshes){c.hit=false;c.mesh.material.color.setHex(c.base);c.mesh.material.emissive.setHex(c.base);}
    resetCarPosition();
  } else {
    state.t=0; state.round++; state.coneHits=0;
    for(const c of coneMeshes){c.hit=false;c.mesh.material.color.setHex(c.base);c.mesh.material.emissive.setHex(c.base);}
    resetCarPosition();
  }
  updateHud();
}

// ------------------------------------------------------------------ render
function animate() {
  requestAnimationFrame(animate);
  const now=performance.now(); const dt=Math.min(.05,Math.max(.001,(now-(animate.last||now))/1000)); animate.last=now;
  if(state.playing && state.track) { step(dt); updateCar(); updateHud(); }
  updateCamera();
  if(state.track) drawTentacles();
  drawGraph();
  renderer.render(scene,camera);
}
function updateCar() {
  carGroup.position.set((state.car.x-CX)*S,0,(state.car.y-CY)*S);
  carGroup.rotation.y=Math.PI/2-state.car.h;
  carGroup.updateMatrixWorld();
  if(steerWheel) steerWheel.rotation.z=-state.steer*3.2;
}
function updateCamera() {
  const fwd=new THREE.Vector3(Math.cos(state.car.h),0,Math.sin(state.car.h));
  const pos=carGroup.position;
  if(state.view==='fp') {
    bodyMesh.visible=false; noseMesh.visible=false; wheelMeshes.forEach(w=>w.visible=false); cockpit.visible=true;
    const eye=new THREE.Vector3(0,.74,-.06).applyMatrix4(carGroup.matrixWorld);
    const look=new THREE.Vector3(0,.28,9).applyMatrix4(carGroup.matrixWorld);
    camera.position.lerp(eye,.35); camera.lookAt(look);
  } else {
    bodyMesh.visible=true; noseMesh.visible=true; wheelMeshes.forEach(w=>w.visible=true); cockpit.visible=false;
    const eye=pos.clone().addScaledVector(fwd,-6.0).add(new THREE.Vector3(0,3.2,0));
    camera.position.lerp(eye,.18); camera.lookAt(pos.clone().addScaledVector(fwd,3));
  }
}
function drawTentacles() {
  tentGroup.clear();
  if(state.mode!=='mpc'||!state.tentacles.length) return;
  for(let i=0;i<state.tentacles.length;i++) {
    const t=state.tentacles[i], pts=t.pts.map(p=>w2v(p,.12));
    const geo=new THREE.BufferGeometry().setFromPoints(pts);
    const mat=i===state.selected?new THREE.LineBasicMaterial({color:0xff3ea5}):new THREE.LineBasicMaterial({color:0x8b93a7,transparent:true,opacity:.3});
    tentGroup.add(new THREE.Line(geo,mat));
  }
}
function drawGraph() {
  const r=graphEl.getBoundingClientRect(),d=devicePixelRatio||1;
  if(graphEl.width!==r.width*d){graphEl.width=r.width*d;graphEl.height=r.height*d;}
  gctx.setTransform(d,0,0,d,0,0); gctx.clearRect(0,0,r.width,r.height);
  const h=state.history; if(h.length<2)return;
  const pad=16,w=r.width-pad*2,ht=r.height-pad*2;
  gctx.strokeStyle='rgba(90,120,150,.14)';gctx.lineWidth=1;
  for(let i=0;i<=3;i++){const y=pad+ht*i/3;gctx.beginPath();gctx.moveTo(pad,y);gctx.lineTo(pad+w,y);gctx.stroke();}
  const n=h.length,maxC=Math.max(.4,...h.map(x=>Math.abs(x.cte)))*1.2,maxV=Math.max(8,...h.map(x=>x.v))*1.1;
  gctx.strokeStyle='#22e0ff';gctx.beginPath();h.forEach((x,i)=>{const X=pad+w*i/(n-1),Y=pad+ht-x.v/maxV*ht;i?gctx.lineTo(X,Y):gctx.moveTo(X,Y);});gctx.stroke();
  gctx.strokeStyle='#d62728';gctx.beginPath();h.forEach((x,i)=>{const X=pad+w*i/(n-1),Y=pad+ht/2-x.cte/(2*maxC)*ht;i?gctx.lineTo(X,Y):gctx.moveTo(X,Y);});gctx.stroke();
  gctx.strokeStyle='#b6ff5c';gctx.beginPath();h.forEach((x,i)=>{const X=pad+w*i/(n-1),Y=pad+ht-x.brake/100*ht;i?gctx.lineTo(X,Y):gctx.moveTo(X,Y);});gctx.stroke();
  gctx.fillStyle='#94a0ba';gctx.font='8px Inter';gctx.fillText('speed / CTE / brake',pad,10);
}

function updateHud() {
  const a=state.lastAct; if(a){
    $('a-speed').textContent=a.speedCmd.toFixed(1);$('a-accel').textContent=a.accel.toFixed(1);$('a-steer').textContent=a.steerDeg.toFixed(1);
    $('a-torque').textContent=a.torque.toFixed(0);$('a-rpm').textContent=a.rpm>0?a.rpm.toFixed(0):'—';$('a-brake').textContent=a.brake.toFixed(0);$('act-mode').textContent=a.mode;
  }
  $('hud-speed').textContent=state.car.v.toFixed(1);$('hud-mode').textContent=state.mode.toUpperCase();
  $('s-cte').textContent=state.cte.toFixed(2);$('s-he').textContent=state.he.toFixed(2);$('s-lap').textContent=state.lap+' / '+(state.idx||0);
  $('cone-hits').textContent=state.coneHits;$('round-label').textContent='round '+state.round;
}
function updateEquation() {
  if(!state.parts||state.mode!=='mpc')return;
  const p=state.parts,t=p.track+p.head+p.comfort+p.soft,w=state.weights;
  $('live-cost').textContent=t.toFixed(3);
  $('live-parts').textContent=`${p.track.toFixed(3)} + ${p.head.toFixed(3)} + ${p.comfort.toFixed(3)} + ${p.soft.toFixed(3)}`;
  if(window.katex){
    try{katex.render(`J=${w.track.toFixed(1)}\\cdot${p.track.toFixed(3)}+${w.head.toFixed(1)}\\cdot${p.head.toFixed(3)}+0.2c+${w.soft.toFixed(1)}\\cdot${p.soft.toFixed(3)}=${t.toFixed(3)}`,document.getElementById('live-eq'),{throwOnError:false,displayMode:true});}catch(e){}
  }
}

// ------------------------------------------------------------------ loading/UI
function resetCarPosition(){
  const p=state.path[0],b=state.path[1];
  state.car={x:p[0],y:p[1],h:Math.atan2(b[1]-p[1],b[0]-p[0]),v:0};
  state.steer=0;state.trail=[];state.history=[];state.t=0;state.lastAct=null;state.idx=0;
}
function resetRound(full=false){
  state.lap=0;state.round=1;state.coneHits=0;state.t=0;
  for(const c of coneMeshes){c.hit=false;c.mesh.material.color.setHex(c.base);c.mesh.material.emissive.setHex(c.base);}
  resetCarPosition();
  if(full){$('hud-speed').textContent='0.0';}
}
async function loadTrack(comp){
  const prof=PROFILES[comp];state.competition=comp;state.closed=prof.closed;state.laps=prof.laps;
  state.targetSpeed=prof.target;state.weights={...prof.weights};
  document.querySelectorAll('#competitions button').forEach(b=>b.classList.toggle('active',b.dataset.comp===comp));
  $('comp-hint').textContent=prof.hint;$('competition-pill').textContent=comp.toUpperCase();
  const track=await fetch(prof.file).then(r=>r.json());
  buildWorld(track);resize();resetRound(true);
}
function setMode(m){
  state.mode=m;document.querySelectorAll('#modes button').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));
  $('mode-label').textContent={manual:'MANUAL',pp:'PID · PP',stanley:'PID · STANLEY',mpc:'MPC',f1:'F1 IMITATION',fly:'FLYWIRE'}[m];
  $('mode-hint').textContent={manual:'WASD drive. Torque/brake actuator path; steering wheel turns in first person.',pp:'PID pure pursuit; speed PID + physical actuator.',stanley:'PID Stanley heading/cross-track law.',mpc:'Sampling MPC with live tentacle fan and soft/hard corridor.',f1:'OpenF1 model for throttle/brake + PP steering stabiliser.',fly:'FlyWire Kenyon/CX readout + PP stabiliser.'}[m];
}
function bindSlider(id,key,fmt){
  const el=$(id),out=$('v-'+id);const sync=()=>{const v=+el.value;out.textContent=fmt(v);
    if(key==='speed')state.targetSpeed=v;if(key==='horizon')state.horizon=v;if(key==='tents')state.nTents=Math.round(v);
    if(key==='wt')state.weights.track=v;if(key==='wh')state.weights.head=v;if(key==='ws')state.weights.soft=v;};
  el.addEventListener('input',sync);sync();
}
function resize(){
  const r=sceneEl.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);
  renderer.setPixelRatio(d);renderer.setSize(r.width,r.height,false);
  camera.aspect=r.width/r.height;camera.updateProjectionMatrix();
  const g=graphEl.getBoundingClientRect();graphEl.width=g.width*d;graphEl.height=g.height*d;
}
async function load(){
  initScene();
  const [f1,fly]=await Promise.all([fetch('f1_model.json').then(r=>r.json()),fetch('fly_model.json').then(r=>r.json())]);
  state.f1=f1;state.fly=fly;
  bindSlider('speed','speed',v=>v.toFixed(1));bindSlider('horizon','horizon',v=>v.toFixed(2));bindSlider('tents','tents',v=>Math.round(v));
  bindSlider('wt','wt',v=>v.toFixed(1));bindSlider('wh','wh',v=>v.toFixed(1));bindSlider('ws','ws',v=>v.toFixed(1));
  document.querySelectorAll('#competitions button').forEach(b=>b.addEventListener('click',()=>loadTrack(b.dataset.comp)));
  document.querySelectorAll('#modes button').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  $('view').addEventListener('click',e=>{state.view=state.view==='chase'?'fp':'chase';e.target.textContent=state.view==='fp'?'Chase view':'First person';});
  $('play').addEventListener('click',e=>{state.playing=!state.playing;e.target.textContent=state.playing?'Pause':'Play';});
  $('reset').addEventListener('click',()=>resetRound(true));
  window.addEventListener('keydown',e=>{
    if(['w','W','ArrowUp'].includes(e.key))state.manual.thr=1;
    if(['s','S','ArrowDown',' '].includes(e.key))state.manual.brk=1;
    if(['a','A','ArrowLeft'].includes(e.key))state.manual.left=1;
    if(['d','D','ArrowRight'].includes(e.key))state.manual.right=1;
  });
  window.addEventListener('keyup',e=>{
    if(['w','W','ArrowUp'].includes(e.key))state.manual.thr=0;
    if(['s','S','ArrowDown',' '].includes(e.key))state.manual.brk=0;
    if(['a','A','ArrowLeft'].includes(e.key))state.manual.left=0;
    if(['d','D','ArrowRight'].includes(e.key))state.manual.right=0;
  });
  window.addEventListener('resize',resize);
  setInterval(updateEquation,250);
  await loadTrack('sprint');setMode('pp');
}
load().catch(e=>{$('hint').textContent='load failed: '+e.message;console.error(e);});
