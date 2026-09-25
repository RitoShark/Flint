import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { Bone } from '@babylonjs/core/Bones/bone';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { playIdleEffects } from '../src/lib/vfx/native/player';
import { nameHash } from '../src/lib/vfx/binHash';
import type { VfxValue } from '../src/lib/vfx/bindings';
import type { SknMeshData } from '../src/lib/api/mesh';

const canvas = document.querySelector('canvas')!;
const engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false });
const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 1);
new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2, 400, Vector3.Zero(), scene);
const box = CreateBox('body', { size: 70 }, scene);
const material = new StandardMaterial('body', scene);
material.disableLighting = true;
material.emissiveColor = new Color3(0, 1, 0);
box.material = material;
const white = document.createElement('canvas');
white.width = white.height = 2;
const ctx = white.getContext('2d')!;
ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 2, 2);
const pixel = white.toDataURL();
const data: SknMeshData = {
    kind: 'skn', materials: [{ name: 'body', start_index: 0, index_count: box.getTotalIndices(), start_vertex: 0, vertex_count: box.getTotalVertices() }],
    positions: Float32Array.from(box.getVerticesData('position')!), normals: Float32Array.from(box.getVerticesData('normal')!), uvs: Float32Array.from(box.getVerticesData('uv')!), indices: Uint32Array.from(box.getIndices()!),
    bounding_box: [[-35,-35,-35],[35,35,35]], vertex_count: box.getTotalVertices(), index_count: box.getTotalIndices(),
};
const skeleton = new Skeleton('test','test',scene);
new Bone('root',skeleton,null,Matrix.Identity());
data.bone_indices = new Uint8Array(data.vertex_count*4);
data.bone_weights = new Float32Array(data.vertex_count*4);
for(let i=0;i<data.vertex_count;i++) data.bone_weights[i*4]=1;
function meshPayload(skinned = false) {
    const header = new TextEncoder().encode(JSON.stringify({kind:skinned?'skn':'scb',name:'cube',materials:skinned?data.materials:['body'],has_bones:skinned,material_ranges:{body:[0,data.index_count]},bounding_box:data.bounding_box,vertex_count:data.vertex_count,index_count:data.index_count,index_bits:32}));
    const start = Math.ceil((4+header.length)/4)*4;
    const arrays = [data.positions,data.normals,data.uvs,data.indices,...(skinned?[data.bone_weights!,data.bone_indices!]:[])];
    const buffer = new ArrayBuffer(start+arrays.reduce((sum,a)=>sum+a.byteLength,0));
    new DataView(buffer).setUint32(0,header.length,true);new Uint8Array(buffer,4,header.length).set(header);
    let offset=start;for(const array of arrays) {new Uint8Array(buffer,offset,array.byteLength).set(new Uint8Array(array.buffer,array.byteOffset,array.byteLength));offset+=array.byteLength;}
    return buffer;
}
(window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
    if (command === 'resolve_asset_path') return args.assetPath;
    if (command === 'decode_dds_to_png') return { data: pixel, width: 2, height: 2, format: 'PNG' };
    if (command === 'read_vfx_cubemap') return Array(6).fill(pixel);
    if (command === 'read_scb_mesh') return meshPayload();
    if (command === 'read_skn_mesh') return meshPayload(true);
    if (command === 'read_skl_skeleton') return {bones:[{name:'root',id:0,parent_id:-1,local_translation:[0,0,0],local_rotation:[0,0,0,1],local_scale:[1,1,1],inverse_bind_matrix:[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]}],influences:[0]};
    if (command === 'read_animation') return {fps:1,frame_count:2,tracks:[{joint_hash:497252,frames:[{translation:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},{translation:[80,0,0],rotation:[0,0,0,1],scale:[1,1,1]}]}]};
    throw new Error(command);
} };
const struct = (name: string, fields: Record<string,VfxValue>): VfxValue => ({type:'struct',classHash:nameHash(name),class:name,object:null,fields:Object.entries(fields).map(([name,value])=>({hash:nameHash(name),name,value}))});
const number = (value: number): VfxValue => ({type:'number',value});
const vector = (...values: number[]): VfxValue => ({type:'vector',values});
const constant = (value: VfxValue) => struct('ValueVector3',{constantValue:value});
const asset: VfxValue = {type:'asset',path:'spark.dds',asset:{kind:'file',path:'spark.dds'}};
const warnings: string[] = [];
let player: ReturnType<typeof playIdleEffects> | null = null;
let hidden: string[] = [];
function open(primitive = 'VfxPrimitiveCameraQuad', extra: Record<string,VfxValue> = {}) {
    player?.dispose();
    const root = struct('VfxSystemDefinitionData', { complexEmitterDefinitionData: {type:'container',items:[struct('VfxEmitterDefinitionData',{
        emitterName:{type:'string',value:'smoke'}, texture:asset, rate:constant(number(12)), particleLifetime:constant(number(3)), birthScale0:constant(vector(180,180,180)), birthColor:constant(vector(1,0,0,1)), blendMode:number(1), primitive:struct(primitive,{}), ...extra,
    })]} });
    player = playIdleEffects(scene,box,skeleton,{attachments:[{bone:'',targetBone:'',position:[0,0,80],system:{entry:'0x12345678',name:null,classHash:nameHash('VfxSystemDefinitionData'),class:null,root,materials:[]}}],warnings:[]},'fixture.skn',message=>warnings.push(message),{meshData:data,joints:[],influences:[0],animation:()=>null,hidden:()=>hidden});
}
function draw() { engine.beginFrame(); player?.render(1/60); scene.render(); engine.endFrame(); }
function pixels() {
    const gl = canvas.getContext('webgl2')!;
    const width = canvas.width, height = canvas.height;
    const bytes = new Uint8Array(width*height*4);
    gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
    let red = 0, green = 0;
    for (let i=0;i<bytes.length;i+=4) { if(bytes[i]>100 && bytes[i+1]<50) red++; if(bytes[i+1]>100&&bytes[i]<50) green++; }
    const draws = scene.meshes.filter(mesh=>mesh.metadata?.idleVfx && mesh.isVisible).length;
    let hash=2166136261;for(const byte of bytes) hash=Math.imul(hash^byte,16777619)>>>0;
    const center = (Math.floor(height/2)*width+Math.floor(width/2))*4;
    return {red,green,hash,draws,center:Array.from(bytes.slice(center,center+4)),glError:gl.getError(),lost:gl.isContextLost(),warnings:[...warnings]};
}
async function frames(count=60) { for(let i=0;i<count;i++) { draw(); if(i%10===0) await new Promise(resolve=>setTimeout(resolve,10)); } await scene.whenReadyAsync(); scene.render(); return pixels(); }
(window as any).vfxSmoke = { open,frames,pixels,hide:(names:string[])=>{hidden=names;},speed:(s:number)=>player?.setSpeed(s),seek:(t:number)=>player?.seek(t),dispose:()=>{player?.dispose();player=null;draw();},scene,engine,box,asset,struct,number,vector,constant };
