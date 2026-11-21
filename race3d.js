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

let scene, camera, renderer, carGroup, bodyMesh, noseMesh, wheelMeshes=[], cockpit, steerWheel, sunLight;
let worldGroup, tentGroup, trailLine, coneMeshes=[], pathCurve;
let S=1.0, CX=0, CY=0;   // track JSON is in metres
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

function noiseTexture(base, specks, size=256, repeat=8) {
  const c=document.createElement('canvas'); c.width=c.height=size;
  const g=c.getContext('2d'); g.fillStyle=base; g.fillRect(0,0,size,size);
  const rnd=(i)=> (Math.sin(i*12.9898)*43758.5453)%1;
  for(let i=0;i<1800;i++){const x=Math.abs(rnd(i*3+1))*size,y=Math.abs(rnd(i*7+2))*size;g.fillStyle=specks[i%specks.length];g.globalAlpha=.18+Math.random()*.25;g.fillRect(x,y,1+Math.random()*2,1+Math.random()*2);}
  g.globalAlpha=1;
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(repeat,repeat); t.colorSpace=THREE.SRGBColorSpace; return t;
}

// ------------------------------------------------------------------ scene
function initScene() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x9db7d4, 0.0032);
  camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);
  renderer = new THREE.WebGLRenderer({canvas:sceneEl, antialias:true, alpha:false});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // gradient sky
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1200, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite:false,
      vertexShader:`varying vec3 vP; void main(){vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader:`varying vec3 vP; void main(){ float h=clamp(normalize(vP).y*.5+.5,0.0,1.0); vec3 top=vec3(.20,.45,.78), bot=vec3(.72,.84,.93); gl_FragColor=vec4(mix(bot,top,pow(h,.85)),1.0); }`
    }));
  scene.add(sky);

  scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x2a3a20, 1.15));
  const sun = new THREE.DirectionalLight(0xfff0d0, 2.6);
  sun.position.set(-60,90,40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048,2048);
  sun.shadow.camera.left=-45; sun.shadow.camera.right=45;
  sun.shadow.camera.top=45; sun.shadow.camera.bottom=-45;
  sun.shadow.camera.near=1; sun.shadow.camera.far=260;
  sun.shadow.bias=-0.0006;
  scene.add(sun); scene.add(sun.target); sunLight=sun;
  const rim = new THREE.PointLight(0x22e0ff, 120, 120); rim.position.set(-30,18,-30); scene.add(rim);


  worldGroup = new THREE.Group(); scene.add(worldGroup);
  tentGroup = new THREE.Group(); scene.add(tentGroup);
  buildCar();
  addClouds();
  resize(); animate();
  window.__lab={state,get camera(){return camera;},get scene(){return scene;},get carGroup(){return carGroup;}};
}

function buildCar() {
  carGroup = new THREE.Group(); carGroup.scale.setScalar(S); scene.add(carGroup);
  const paint = new THREE.MeshStandardMaterial({color:0xff4d00, metalness:.55, roughness:.32});
  const dark = new THREE.MeshStandardMaterial({color:0x14161c, roughness:.7, metalness:.2});
  const glass = new THREE.MeshStandardMaterial({color:0x0b1522, metalness:.65, roughness:.12});
  const trim = new THREE.MeshStandardMaterial({color:0x2a2d34, roughness:.8});

  const add=(geo,mat,x,y,z)=>{const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;carGroup.add(m);return m;};
  bodyMesh = add(new THREE.BoxGeometry(1.02,.30,1.95), paint, 0,.36,0);
  noseMesh = add(new THREE.BoxGeometry(.82,.17,.62), paint, 0,.30,1.16);
  add(new THREE.BoxGeometry(1.12,.10,.5), trim, 0,.22,1.22);        // front splitter
  add(new THREE.BoxGeometry(.66,.32,.52), glass, 0,.63,-.12);       // cockpit
  add(new THREE.BoxGeometry(.70,.06,.56), paint, 0,.80,-.12);       // roof
  add(new THREE.BoxGeometry(.96,.05,.30), paint, 0,.73,-1.00);     // rear wing
  add(new THREE.BoxGeometry(.06,.22,.08), trim, -.36,.61,-1.0);
  add(new THREE.BoxGeometry(.06,.22,.08), trim, .36,.61,-1.0);
  add(new THREE.BoxGeometry(.88,.10,.08), dark, 0,.20,-1.02);       // diffuser
  add(new THREE.BoxGeometry(.93,.05,.06), new THREE.MeshStandardMaterial({color:0x330000,emissive:0xff2200,emissiveIntensity:1.5}), 0,.44,-.97);

  const headMat=new THREE.MeshStandardMaterial({color:0xfff8dd,emissive:0xfff2b0,emissiveIntensity:2});
  add(new THREE.BoxGeometry(.20,.06,.04), headMat, -.30,.38,1.46);
  add(new THREE.BoxGeometry(.20,.06,.04), headMat, .30,.38,1.46);

  for(const [x,z] of [[-.56,.68],[.56,.68],[-.56,-.68],[.56,-.68]]){
    add(new THREE.BoxGeometry(.26,.055,.60),paint,x,.50,z);
  }
  const helmet=new THREE.Mesh(new THREE.SphereGeometry(.115,12,10),new THREE.MeshStandardMaterial({color:0xf5f7fa,roughness:.35}));
  helmet.position.set(0,.75,-.06); carGroup.add(helmet);
  const visor=new THREE.Mesh(new THREE.BoxGeometry(.15,.05,.02),new THREE.MeshStandardMaterial({color:0x101820,metalness:.8,roughness:.2}));
  visor.position.set(0,.75,.04); carGroup.add(visor);

  const wheelGeo = new THREE.CylinderGeometry(.245,.245,.19,18);
  const wheelMat = new THREE.MeshStandardMaterial({color:0x111318, roughness:.85});
  const rimMat   = new THREE.MeshStandardMaterial({color:0xc9ced6, metalness:.9, roughness:.3});
  for (const [x,z,front] of [[-.56,.68,true],[.56,.68,true],[-.56,-.68,false],[.56,-.68,false]]) {
    const pivot=new THREE.Group(); pivot.position.set(x,.245,z); carGroup.add(pivot);
    const w=new THREE.Mesh(wheelGeo,wheelMat); w.rotation.z=Math.PI/2; w.castShadow=true; pivot.add(w);
    const rim=new THREE.Mesh(new THREE.CylinderGeometry(.13,.13,.20,12),rimMat); rim.rotation.z=Math.PI/2; pivot.add(rim);
    wheelMeshes.push(w); if(front) (carGroup.userData.frontWheels||(carGroup.userData.frontWheels=[])).push(pivot);
  }
  cockpit = new THREE.Group(); carGroup.add(cockpit); cockpit.visible=false;
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.2,.06,.28), new THREE.MeshStandardMaterial({color:0x0b0e15, roughness:.8}));
  dash.position.set(0,.52,.62); cockpit.add(dash);
  steerWheel = new THREE.Mesh(new THREE.TorusGeometry(.11,.022,8,24), new THREE.MeshStandardMaterial({color:0xdedede, metalness:.5, roughness:.3}));
  steerWheel.position.set(0,.52,.52); cockpit.add(steerWheel);
}

function addClouds() {
  const c=document.createElement('canvas'); c.width=c.height=128;
  const g=c.getContext('2d');
  const grd=g.createRadialGradient(64,64,4,64,64,62);
  grd.addColorStop(0,'rgba(255,255,255,.95)'); grd.addColorStop(.55,'rgba(255,255,255,.45)'); grd.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=grd; g.fillRect(0,0,128,128);
  const tex=new THREE.CanvasTexture(c);
  for(let i=0;i<16;i++){
    const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true,opacity:.55,depthWrite:false}));
    sp.position.set((Math.random()-.5)*1500, 150+Math.random()*160, (Math.random()-.5)*1500);
    const s=120+Math.random()*260; sp.scale.set(s,s*.45,1); scene.add(sp);
  }
}

function buildWorld(track) {
  worldGroup.clear(); coneMeshes=[];
  state.track=track; state.path=track.raceline;
  const pts=track.raceline;
  CX=pts.reduce((s,p)=>s+p[0],0)/pts.length; CY=pts.reduce((s,p)=>s+p[1],0)/pts.length;
  state.length=pts.reduce((s,p,i)=>s+Math.hypot(pts[(i+1)%pts.length][0]-p[0],pts[(i+1)%pts.length][1]-p[1]),0);
  pathCurve=new THREE.CatmullRomCurve3(pts.map(p=>w2v(p)), state.closed, 'catmullrom', .08);

  const tube=new THREE.Mesh(new THREE.TubeGeometry(pathCurve, 900, .035, 8, state.closed),
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
  const cg=new THREE.ConeGeometry(.09,.34,12);
  for(const c of track.cones||[]) {
    if(c[0]==='car_start'||c[0]==='orange'||c[0]==='big_orange') continue;
    const col=c[0]==='blue'?0x2c6bff:0xe0b000;
    const m=new THREE.Mesh(cg,new THREE.MeshStandardMaterial({color:col,emissive:col,emissiveIntensity:.25}));
    m.position.copy(w2v([c[1],c[2]],.17)); worldGroup.add(m);
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
  buildRoad(track);
  buildEnvironment(track);
  buildGantry(track);
  resetRound(true);
}

function buildRoad(track) {
  const pts=track.raceline, n=pts.length, half=2.2, pos=[], uv=[], idx=[];
  let dist=0;
  for(let i=0;i<n;i++){
    const a=pts[(i-1+n)%n], b=pts[(i+1)%n];
    let tx=b[0]-a[0],ty=b[1]-a[1]; const l=Math.hypot(tx,ty)||1; tx/=l;ty/=l;
    const nx=-ty,ny=tx;
    const p=pts[i];
    if(i) dist+=Math.hypot(p[0]-pts[i-1][0],p[1]-pts[i-1][1]);
    for(const sgn of [-1,1]){
      const q=w2v([p[0]+nx*half*sgn,p[1]+ny*half*sgn],.008);
      pos.push(q.x,q.y,q.z); uv.push(sgn<0?0:1,dist/6);
    }
  }
  for(let i=0;i<n;i++){
    const j=(i+1)%n, a=i*2,b=i*2+1,c=j*2,d=j*2+1;
    idx.push(a,b,c,b,d,c);
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geo.setIndex(idx); geo.computeVertexNormals();
  const mat=new THREE.MeshStandardMaterial({
    map:noiseTexture('#3a3d42',['#484c52','#2e3135','#5b6066','#24272b'],256,28),
    roughness:.82, metalness:.05, side:THREE.DoubleSide});
  const road=new THREE.Mesh(geo,mat); road.position.y=.006; road.receiveShadow=true; worldGroup.add(road);

  // white edge lines
  for(const sgn of [-1,1]){
    const edge=pts.map((p,i)=>{const a=pts[(i-1+n)%n],b=pts[(i+1)%n];let tx=b[0]-a[0],ty=b[1]-a[1];const l=Math.hypot(tx,ty)||1;tx/=l;ty/=l;return w2v([p[0]-ty*half*.98*sgn,p[1]+tx*half*.98*sgn],.018);});
    worldGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(edge),new THREE.LineBasicMaterial({color:0xe8edf5,transparent:true,opacity:.7})));
  }

  // red/white kerbs just outside the white lines
  const kc=document.createElement('canvas'); kc.width=64; kc.height=8;
  const kg=kc.getContext('2d');
  for(let i=0;i<8;i++){kg.fillStyle=i%2?'#e9ecef':'#cf2b2b';kg.fillRect(i*8,0,8,8);}
  const kerbTex=new THREE.CanvasTexture(kc); kerbTex.wrapS=THREE.RepeatWrapping; kerbTex.colorSpace=THREE.SRGBColorSpace;
  for(const sgn of [-1,1]){
    const pos=[],uv=[],idx=[]; let dist=0;
    for(let i=0;i<n;i++){
      const a=pts[(i-1+n)%n], b=pts[(i+1)%n], p=pts[i];
      let tx=b[0]-a[0],ty=b[1]-a[1]; const l=Math.hypot(tx,ty)||1; tx/=l;ty/=l;
      const nx=-ty,ny=tx;
      if(i) dist+=Math.hypot(p[0]-pts[i-1][0],p[1]-pts[i-1][1]);
      for(const [off,v] of [[half,0],[half+.55,1]]){
        const q=w2v([p[0]+nx*off*sgn,p[1]+ny*off*sgn],.012);
        pos.push(q.x,q.y,q.z); uv.push(dist/3.2,v);
      }
    }
    for(let i=0;i<n;i++){
      const j=(i+1)%n,a=i*2,b=i*2+1,c=j*2,d=j*2+1;
      idx.push(a,b,c,b,d,c);
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
    geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    geo.setIndex(idx); geo.computeVertexNormals();
    const kerb=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({map:kerbTex,roughness:.75,side:THREE.DoubleSide}));
    kerb.position.y=.004; kerb.receiveShadow=true; worldGroup.add(kerb);
  }
}

function buildEnvironment(track) {
  const pts=track.raceline, n=pts.length;
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
  for(const p of pts){minX=Math.min(minX,p[0]);maxX=Math.max(maxX,p[0]);minY=Math.min(minY,p[1]);maxY=Math.max(maxY,p[1]);}
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
  const span=Math.max(maxX-minX,maxY-minY,60);
  const rnd=i=>Math.abs((Math.sin(i*12.9898+4.1)*43758.5453)%1);

  // rounded hills / cliffs ringing the circuit (real metres, well outside the track)
  const hillColors=[0x5c6b4a,0x6b7357,0x4d5c47,0x7a7d63,0x556149];
  for(let i=0;i<30;i++){
    const ang=rnd(i+1)*Math.PI*2;
    const h=span*(0.06+rnd(i+3)*0.15), w=h*(1.3+rnd(i+7)*1.2);
    const rad=span*1.3+w+rnd(i+11)*span*0.5;
    const geo=new THREE.SphereGeometry(w,10,7,0,Math.PI*2,0,Math.PI*0.55);
    const m=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:hillColors[i%hillColors.length],roughness:1,flatShading:true}));
    m.position.set(cx+Math.cos(ang)*rad,-h*0.18,cy+Math.sin(ang)*rad);
    m.scale.y=h/Math.max(w,1);
    m.rotation.y=rnd(i+5)*Math.PI*2;
    worldGroup.add(m);
  }

  // trees lining the road, offset perpendicular to the race line
  const trunkMat=new THREE.MeshStandardMaterial({color:0x4a3524,roughness:1});
  const leafMats=[0x2f5a2b,0x396b32,0x27491f,0x446f33].map(c=>new THREE.MeshStandardMaterial({color:c,roughness:1,flatShading:true}));
  const step=Math.max(1,Math.round(6/(state.length/n)));
  let ti=0;
  for(let i=0;i<n;i+=step){
    const a=pts[(i-1+n)%n],b=pts[(i+1)%n],p=pts[i];
    let tx=b[0]-a[0],ty=b[1]-a[1];const l=Math.hypot(tx,ty)||1;tx/=l;ty/=l;
    const nx=-ty,ny=tx, side=(ti%2?1:-1), off=6+rnd(i+30)*13;
    if(rnd(i+40)<0.35){ti++;continue;}
    const X=p[0]+nx*off*side, Y=p[1]+ny*off*side;
    const hgt=4.5+rnd(i+50)*5, wid=hgt*(0.22+rnd(i+60)*0.1);
    const tr=new THREE.Mesh(new THREE.CylinderGeometry(wid*0.13,wid*0.18,hgt*0.42,6),trunkMat);
    tr.position.copy(w2v([X,Y],hgt*0.21));
    const cr=new THREE.Mesh(new THREE.ConeGeometry(wid,hgt*0.82,7),leafMats[i%leafMats.length]);
    cr.position.copy(w2v([X,Y],hgt*0.58));
    const cr2=new THREE.Mesh(new THREE.ConeGeometry(wid*0.7,hgt*0.55,7),leafMats[(i+1)%leafMats.length]);
    cr2.position.copy(w2v([X,Y],hgt*0.86));
    worldGroup.add(tr,cr,cr2);
    ti++;
  }

  // tyre stacks / barriers along the outside of the track
  const tyreMat=new THREE.MeshStandardMaterial({color:0x17191d,roughness:.95});
  const tyreGeo=new THREE.CylinderGeometry(.38,.38,.24,14);
  const stackEvery=Math.max(1,Math.round(26/(state.length/n)));
  for(let i=10;i<n;i+=stackEvery){
    const a=pts[(i-1+n)%n],b=pts[(i+1)%n],p=pts[i];
    let tx=b[0]-a[0],ty=b[1]-a[1];const l=Math.hypot(tx,ty)||1;tx/=l;ty/=l;
    const side=(Math.round(i/stackEvery)%2)?1:-1, off=5.6+rnd(i+70)*1.2;
    const X=p[0]-ty*off*side, Y=p[1]+tx*off*side;
    for(let k=0;k<3;k++){
      const t=new THREE.Mesh(tyreGeo,tyreMat); t.position.copy(w2v([X,Y],.13+k*.24)); t.rotation.y=rnd(i+k)*3; t.castShadow=true; worldGroup.add(t);
    }
  }

  // grass island + sea to the horizon
  const island=new THREE.Mesh(new THREE.CircleGeometry(span*1.62,72),
    new THREE.MeshStandardMaterial({map:noiseTexture('#48683a',['#5b8148','#35502b','#6a9152','#2b4023'],256,240),roughness:1}));
  island.rotation.x=-Math.PI/2; island.position.set(cx,-0.05,cy); island.receiveShadow=true; worldGroup.add(island);
  const sea=new THREE.Mesh(new THREE.PlaneGeometry(6000,6000),
    new THREE.MeshStandardMaterial({color:0x2f6f8f,roughness:.35,metalness:.25}));
  sea.rotation.x=-Math.PI/2; sea.position.set(cx,-0.75,cy); worldGroup.add(sea);

  // distant coastline in front of the sea
  const coast=new THREE.Mesh(new THREE.TorusGeometry(span*1.62,span*0.03,6,96),
    new THREE.MeshStandardMaterial({color:0x8a7f63,roughness:1,flatShading:true}));
  coast.rotation.x=Math.PI/2; coast.position.set(cx,-span*0.28,cy); worldGroup.add(coast);
}

function buildGantry(track) {
  const pts=track.raceline; if(!pts||pts.length<2) return;
  const a=pts[0], b=pts[1];
  const yaw=Math.atan2(b[1]-a[1], b[0]-a[0]);
  const g=new THREE.Group();
  g.position.copy(w2v(a,0)); g.rotation.y=Math.PI/2-yaw;
  const steel=new THREE.MeshStandardMaterial({color:0x2b3442, metalness:.7, roughness:.35});
  for(const x of [-4.6,4.6]){
    const post=new THREE.Mesh(new THREE.CylinderGeometry(.16,.18,5.2,10),steel);
    post.position.set(x,2.6,0); post.castShadow=true; g.add(post);
  }
  const bar=new THREE.Mesh(new THREE.BoxGeometry(9.6,.7,.35),steel);
  bar.position.set(0,5.0,0); bar.castShadow=true; g.add(bar);
  const c=document.createElement('canvas'); c.width=512; c.height=96;
  const ctx=c.getContext('2d');
  ctx.fillStyle='#11151b'; ctx.fillRect(0,0,512,96);
  for(let i=0;i<32;i++){ctx.fillStyle=(i%2)?'#eff2f5':'#11151b';ctx.fillRect(i*16,0,16,14);ctx.fillStyle=(i%2)?'#11151b':'#eff2f5';ctx.fillRect(i*16,82,16,14);}
  ctx.fillStyle='#f4f7fb'; ctx.font='bold 40px Inter, sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('START  ·  FINISH',256,50);
  const tex=new THREE.CanvasTexture(c); tex.colorSpace=THREE.SRGBColorSpace;
  const banner=new THREE.Mesh(new THREE.BoxGeometry(9.2,1.15,.10),
    new THREE.MeshStandardMaterial({map:tex,roughness:.55,emissive:0x0a0a0a}));
  banner.position.set(0,4.25,0); g.add(banner);
  worldGroup.add(g);
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
  state.t=0; state.coneHits=0;
  for(const c of coneMeshes){c.hit=false;c.mesh.material.color.setHex(c.base);c.mesh.material.emissive.setHex(c.base);}
  // Keep the car where it is: only the cone count and cone states reset.

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
  for(const w of (carGroup.userData.frontWheels||[])) w.rotation.y=-state.steer;
  if(sunLight){
    sunLight.position.set(carGroup.position.x-38,72,carGroup.position.z+30);
    sunLight.target.position.copy(carGroup.position);
    sunLight.target.updateMatrixWorld();
  }
}
function updateCamera() {
  const fwd=new THREE.Vector3(Math.cos(state.car.h),0,Math.sin(state.car.h));
  const pos=carGroup.position;
  bodyMesh.visible=true; noseMesh.visible=true; wheelMeshes.forEach(w=>w.visible=true); cockpit.visible=false;
  const eye=pos.clone().addScaledVector(fwd,-5.6).add(new THREE.Vector3(0,2.35,0));
  if(state.idx>0||state.t>0) camera.position.lerp(eye,.14); else camera.position.copy(eye);
  camera.lookAt(pos.clone().addScaledVector(fwd,7.5).add(new THREE.Vector3(0,0.95,0)));
  const fov=55+Math.min(18,state.car.v*1.5);
  if(Math.abs(camera.fov-fov)>.05){camera.fov+=(fov-camera.fov)*.06;camera.updateProjectionMatrix();}
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
