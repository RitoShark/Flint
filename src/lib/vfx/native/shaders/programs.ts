const declarations = (qualifier: string, entries: Record<string, string>) => Object.entries(entries).map(([name, type]) => `${qualifier} ${type} ${name};`).join('\n');
const common = {vUv: 'vec2', vColor: 'vec4', vLookup: 'vec2', vErode: 'float'};
const layers = {vTurn: 'vec3', vShift: 'vec4', vTurnMult: 'vec3', vShiftMult: 'vec4'};
const ribbon = {vAlphaUv: 'vec2', vCell: 'vec2', vMultUv: 'vec2', vMultCell: 'vec2'};
const ground = `vec4 worldPoint(vec4 p) {
#ifdef GROUND_LAYER
p.y = 0.0;
#endif
return p;
}`;
const rotate = `mat2 rotation2(float a) { return mat2(cos(a), sin(a), -sin(a), cos(a)); }`;
const sample = `
vec2 addressUv(vec2 p, int mode) {
  if (mode == 0) return fract(p);
  if (mode == 1) return 1.0-abs(mod(p,2.0)-1.0);
  return clamp(p,vec2(0.0),vec2(1.0));
}
vec4 readLayer(sampler2D image, vec2 p, vec2 tile, vec2 extent, int mode) {
  if (mode == 3 && (any(lessThan(p,vec2(0.0))) || any(greaterThan(p,vec2(1.0))))) return vec4(0.0);
  return texture2D(image,tile+addressUv(p,mode)*extent);
}
vec2 transformUv(vec2 p, vec3 transform, vec4 shift, vec2 pivot, vec2 flip) {
  vec2 uv=rotation2(transform.x)*((p-pivot)*transform.yz)+pivot+shift.xy;
  return uv*(1.0-2.0*flip)+flip;
}`;

export function particleFragment(strip = false): string {
    return `${declarations('varying', {...common, ...(strip ? ribbon : layers)})}
${declarations('uniform', {map:'sampler2D', mapMult:'sampler2D', alphaRef:'float', address:'int', addressMult:'int', cellMult:'vec2',
    ...(strip ? {cellSize:'vec2'} : {cell:'vec2', center:'vec2', flip:'vec2', centerMult:'vec2', flipMult:'vec2'}),
    mapRamp:'sampler2D', mapPalette:'sampler2D', paletteMix:'vec4', paletteRow:'float', paletteScroll:'vec2', addressPalette:'int', viewport:'vec2'})}
${rotate}
${sample}
#ifdef WIREFRAME
uniform vec4 wireColor;
#endif
#ifdef EROSION
${declarations('uniform', {mapErosion:'sampler2D', addressErosion:'int', erosionMix:'vec4', erosionDefault:'vec4', featherRate:'vec2', sliceWidth:'float'})}
#endif
#ifdef SOFT
${declarations('uniform', {softParams:'vec4', softControl:'vec4', sceneDepth:'sampler2D', depthRange:'vec2'})}
#endif
#ifdef DISTORTS
${declarations('uniform', {mapNormal:'sampler2D', warp:'float', frame:'sampler2D'})}
#endif
#if SHEEN > 0
${declarations('uniform', {mapReflection:'samplerCube', reflectionTint:'vec3'})}
varying vec3 vRim;
varying vec4 vReflect;
#endif
void main() {
#ifdef WIREFRAME
gl_FragColor=wireColor;
return;
#endif
${strip ? 'vec2 baseUv=vUv; vec2 secondaryUv=vMultUv; vec2 tile=vCell; vec2 secondaryTile=vMultCell; vec2 extent=cellSize;' :
    'vec2 baseUv=transformUv(vUv,vTurn,vShift,center,flip); vec2 secondaryUv=transformUv(vUv,vTurnMult,vShiftMult,centerMult,flipMult); vec2 tile=vShift.zw; vec2 secondaryTile=vShiftMult.zw; vec2 extent=cell;'}
vec4 surface=vec4(1.0);
#ifdef HAS_MAP
surface=readLayer(map,baseUv,tile,extent,address);
#if LOCK_ALPHA == 1
surface.a=${strip ? 'readLayer(map,vAlphaUv,vec2(0.0),vec2(1.0),address).a' : 'texture2D(map,vUv).a'};
${strip ? '' : `#elif LOCK_ALPHA == 2
vec2 alphaUv=rotation2(vTurn.x)*(vUv*vTurn.yz);
surface.a=readLayer(map,alphaUv*(1.0-2.0*flip)+flip,vec2(0.0),vec2(1.0),address).a;`}
#endif
#elif defined(FALLOFF)
surface.a=1.0-smoothstep(0.0,0.5,distance(vUv,vec2(0.5)));
#endif
#ifdef HAS_PALETTE
vec2 paletteUv=vec2(clamp(dot(surface,paletteMix),0.0,1.0),paletteRow)+paletteScroll;
surface.rgb=readLayer(mapPalette,paletteUv,vec2(0.0),vec2(1.0),addressPalette).rgb;
#endif
#ifdef HAS_RAMP
#ifdef RAMP_AT_MULT
surface*=texture2D(mapRamp,secondaryTile+secondaryUv*cellMult);
#else
surface*=texture2D(mapRamp,vLookup);
#endif
#endif
#ifdef HAS_MAP_MULT
surface*=readLayer(mapMult,secondaryUv,secondaryTile,cellMult,addressMult);
#endif
#ifdef EROSION
vec4 erosion=erosionDefault;
#ifdef HAS_MAP_EROSION
erosion=readLayer(mapErosion,tile+baseUv*extent,vec2(0.0),vec2(1.0),addressErosion);
#endif
float threshold=vErode-clamp(dot(erosion,erosionMix),0.0,1.0);
vec2 band=clamp((vec2(threshold)+vec2(sliceWidth,0.0))*featherRate,0.0,1.0);
surface.a*=band.x-band.y;
#endif
vec4 result=surface*vColor;
if(result.a<alphaRef) discard;
#if SHEEN > 0
vec3 shine=vec3(0.0);
#ifdef REFLECTS
shine=textureCube(mapReflection,vReflect.xyz).rgb*vReflect.w*mix(vec3(1.0),reflectionTint,vReflect.w);
#if SHEEN == 2
shine*=surface.a;
#endif
#endif
result.rgb=clamp(result.rgb+shine+vRim*(SHEEN==2?surface.a:result.a),0.0,1.0);
#endif
#ifdef SOFT
float stored=texture2D(sceneDepth,gl_FragCoord.xy/viewport).r;
vec2 depths=(depthRange.x*depthRange.y)/((depthRange.y-depthRange.x)*vec2(gl_FragCoord.z,stored)-depthRange.y);
vec2 distanceFade=clamp((depths.x-depths.y-softParams.xy)*softParams.zw,0.0,1.0);
vec2 eased=distanceFade*distanceFade*(3.0-2.0*distanceFade);
float fade=eased.x-eased.y;
result*=vec4(vec3(softControl.x+fade*softControl.y),softControl.z+fade*softControl.w);
#endif
#ifdef DISTORTS
if(warp!=0.0) {
vec4 normalSample=vec4(0.5,0.5,1.0,0.0);
#ifdef HAS_NORMAL
normalSample=texture2D(mapNormal,baseUv);
#endif
float coverage=result.a*normalSample.a;
vec2 displacement=(normalSample.xy*2.0-1.0)*warp*coverage*vec2(viewport.y/viewport.x,1.0);
result=vec4(texture2D(frame,clamp(gl_FragCoord.xy/viewport+displacement,0.0,1.0)).rgb,coverage);
}
#endif
gl_FragColor=result;
}`;
}

export function quadVertex(): string {
    return `${declarations('attribute', {corner:'vec2', center:'vec3', size:'vec3', color:'vec4', roll:'float', basisX:'vec3', basisY:'vec3', basisZ:'vec3', uvTurn:'vec3', uvShift:'vec4', uvTurnMult:'vec3', uvShiftMult:'vec4', lookup:'vec3'})}
${declarations('uniform', {pushPull:'float', reach:'float', pivot:'float'})}
${declarations('varying', {...common,...layers})}
${ground}
${rotate}
void main() {
vUv=corner*vec2(1.0,-1.0)+0.5;
vColor=color; vTurn=uvTurn; vShift=uvShift; vTurnMult=uvTurnMult; vShiftMult=uvShiftMult; vLookup=lookup.xy; vErode=lookup.z;
vec2 p=(corner+vec2(0.0,pivot))*reach;
vec4 view;
#if PLANE > 0
vec3 u=vec3(0.0,1.0,0.0); vec3 v=vec3(0.0,0.0,-1.0);
#if PLANE == 2
u=vec3(1.0,0.0,0.0);
#elif PLANE == 3
v=vec3(1.0,0.0,0.0);
#endif
vec3 n=cross(v,u);
vec3 offset=(u*cos(roll)-cross(n,u)*sin(roll))*p.y*size.y+(v*cos(roll)-cross(n,v)*sin(roll))*p.x*size.x;
view=viewMatrix*worldPoint(modelMatrix*vec4(center+offset*vec3(-1.0,1.0,1.0),1.0));
#elif defined(BILLBOARD)
#ifdef DIRECTED
vec2 up=(mat3(viewMatrix)*basisY).xy;
up=dot(up,up)>0.0?normalize(up):vec2(0.0,1.0);
vec2 offset=mat2(up.y,-up.x,up.x,up.y)*(p*size.xy);
#else
vec2 offset=(rotation2(roll)*p)*size.xy;
#endif
#ifdef GROUND_LAYER
vec3 worldOffset=vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0])*offset.x+vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1])*offset.y;
view=viewMatrix*worldPoint(modelMatrix*vec4(center+worldOffset,1.0));
#else
view=modelViewMatrix*vec4(center,1.0); view.xy+=offset;
#endif
#elif defined(RAY)
vec3 width=cross(basisZ,cameraPosition-center);
width=dot(width,width)>0.0?-normalize(width):basisX;
view=viewMatrix*worldPoint(modelMatrix*vec4(center+basisZ*(size.z+(corner.y+0.5)*size.y)+width*corner.x*size.x,1.0));
#else
vUv=corner.yx+0.5;
view=viewMatrix*worldPoint(modelMatrix*vec4(center+basisX*p.x*size.x+basisY*p.y*size.y,1.0));
#endif
if(dot(view.xyz,view.xyz)>0.0) view.xyz+=normalize(view.xyz)*pushPull;
gl_Position=projectionMatrix*view;
}`;
}

export function ribbonVertex(): string {
    return `${ground}
${declarations('attribute', {alphaUv:'vec2',cell:'vec2',tint:'vec4',lookup:'vec2',erode:'float',multUv:'vec2',multCell:'vec2'})}
${declarations('varying', {...common,...ribbon})}
void main() {
vUv=uv; vAlphaUv=alphaUv; vCell=cell; vColor=tint; vLookup=lookup; vErode=erode; vMultUv=multUv; vMultCell=multCell;
gl_Position=projectionMatrix*viewMatrix*worldPoint(modelMatrix*vec4(position,1.0));
}`;
}

export function meshVertex(): string {
    return `${ground}
${declarations('attribute', {tint:'vec4',erode:'float',uvTurn:'vec3',uvShift:'vec4',uvTurnMult:'vec3',uvShiftMult:'vec4'})}
${declarations('varying', {...common,...layers})}
#ifdef PARTICLE_SKINNING
uniform sampler2D particleBones;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
#endif
#if SHEEN > 0
uniform vec4 fresnel;
uniform vec4 reflection;
varying vec3 vRim;
varying vec4 vReflect;
#endif
void main() {
vUv=uv; vColor=tint; vErode=erode; vTurn=uvTurn; vShift=uvShift; vTurnMult=uvTurnMult; vShiftMult=uvShiftMult; vLookup=vec2(0.0);
mat4 deformation=mat4(1.0);
#ifdef PARTICLE_SKINNING
if(dot(skinWeight,vec4(1.0))>0.0) {
deformation=mat4(0.0);
for(int influence=0;influence<4;influence++) {
if(skinWeight[influence]<=0.0) continue;
int column=int(skinIndex[influence])*4;
for(int row=0;row<4;row++) deformation[row]+=skinWeight[influence]*texelFetch(particleBones,ivec2(column+row,gl_InstanceID),0);
}
}
#endif
vec4 world=worldPoint(modelMatrix*instanceMatrix*deformation*vec4(position,1.0));
#if SHEEN > 0
vec3 surface=mat3(modelMatrix)*mat3(instanceMatrix)*mat3(deformation)*normal;
vRim=vec3(0.0); vReflect=vec4(0.0);
if(dot(surface,surface)>0.0) {
vec3 incident=normalize(world.xyz-cameraPosition); vec3 n=normalize(surface);
float facing=max(1e-30,clamp(-dot(incident,n),0.0,1.0));
vRim=fresnel.rgb*(1.0-pow(facing,fresnel.w));
vReflect=vec4(reflect(incident,n)*vec3(-1.0,1.0,1.0),mix(reflection.y,reflection.z,1.0-pow(facing,reflection.x)));
}
#endif
gl_Position=projectionMatrix*viewMatrix*world;
}`;
}

export function customFragment(): string {
    return `${declarations('uniform', {map:'sampler2D',materialTint:'vec4',materialRepeat:'vec2',materialAddress:'vec2',alphaRef:'float'})}
varying vec2 vUv;
varying vec4 vColor;
#ifdef WIREFRAME
uniform vec4 wireColor;
#endif
float materialUv(float p,float mode) { if(mode==0.0) return fract(p); if(mode==2.0) return 1.0-abs(mod(p,2.0)-1.0); return clamp(p,0.0,1.0); }
void main() {
#ifdef WIREFRAME
gl_FragColor=wireColor; return;
#endif
vec4 surface=vec4(1.0);
#if CUSTOM_TEXTURE == 1
vec2 p=vUv*materialRepeat;
surface=texture2D(map,vec2(materialUv(p.x,materialAddress.x),materialUv(p.y,materialAddress.y)));
for(int axis=0;axis<2;axis++) if(materialAddress[axis]==3.0 && (p[axis]<0.0 || p[axis]>1.0)) surface=vec4(0.0);
#endif
gl_FragColor=surface*vColor*materialTint;
if(gl_FragColor.a<alphaRef) discard;
#if CUSTOM_PREMULTIPLIED == 1
gl_FragColor.rgb*=gl_FragColor.a;
#endif
}`;
}
