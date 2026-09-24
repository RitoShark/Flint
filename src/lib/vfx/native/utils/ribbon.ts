import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { AttributeData, GeometryData, DynamicDrawUsage } from '../data';
import { AXIS_SIGN } from '../types';
import { TRAIL_SMOOTHING } from '../../engine/model/enums';
import type { UvLayer } from '../../engine/model/model';
import type { Point } from '../../engine/model/rig';
import { turnInto } from '../../engine/utils/basis';
import { written } from './buffers';
import type { UvDraw } from './uvTransform';

export const UV_STRIDE = 7;
const strandWidths = {position:3,width:1,color:4,side:3,tiling:2,odometer:1,uv:7,multUv:7,lookup:2,erode:1} as const;
export type Strand = {count:number} & {[K in keyof typeof strandWidths]: Float32Array};
export function strand(capacity: number): Strand {
    const columns = Object.fromEntries(Object.entries(strandWidths).map(([key,width]) => [key,new Float32Array(capacity*width)])) as Omit<Strand,'count'>;
    columns.erode.fill(1);
    return {count:0,...columns};
}
export function packUv(draw: UvDraw, output: Float32Array, offset: number): void {
    output.set([draw.turn,draw.scaleU,draw.scaleV,draw.offsetU,draw.offsetV,draw.cellU,draw.cellV],offset);
}
export type RibbonLayer = Pick<UvLayer,'center'|'flipU'|'flipV'>;
export interface RibbonLayers {readonly base:RibbonLayer; readonly mult:RibbonLayer|null}
export interface TrailBuild {readonly view:Point|null; readonly wake:boolean; readonly smoothing:number; readonly cutoff:number; readonly layers:RibbonLayers}
const vertexWidths = {position:3,uv:2,alphaUv:2,cell:2,tint:4,lookup:2,erode:1,multUv:2,multCell:2} as const;
type VertexColumns = {[K in keyof typeof vertexWidths]:Float32Array};
export type RibbonArrays = VertexColumns & {index:Uint32Array;edges:Uint32Array};
export interface Cursor {vertex:number;index:number}
export interface BeamEnds {readonly source:Point;readonly target:Point;readonly eye:Point|null}
export interface BeamParticle {
    readonly scale:Float32Array;readonly color:Float32Array;readonly tiling:Float32Array;readonly tilingAt:number;
    readonly turn:Float32Array;readonly local:Point;readonly uv:Float32Array;readonly uvAt:number;
    readonly multUv:Float32Array;readonly lookup:Float32Array;erode:number;
}

function textureCoordinates(output:RibbonArrays,index:number,u:number,v:number,transform:Float32Array,offset:number,layer:RibbonLayer,mult=false,transpose=false):void {
    const uv=mult?output.multUv:output.uv;
    const cell=mult?output.multCell:output.cell;
    const cosine=Math.cos(transform[offset]);
    const sine=Math.sin(transform[offset]);
    const transformPoint=(pivot:boolean,target:Float32Array) => {
        const x=(u-(pivot?layer.center[0]:0))*transform[offset+1];
        const y=(v-(pivot?layer.center[1]:0))*transform[offset+2];
        const s=x*cosine-y*sine+(pivot?layer.center[0]+transform[offset+3]:0);
        const t=x*sine+y*cosine+(pivot?layer.center[1]+transform[offset+4]:0);
        target[index*2+(transpose?1:0)]=layer.flipU?1-s:s;
        target[index*2+(transpose?0:1)]=layer.flipV?1-t:t;
    };
    transformPoint(true,uv);
    if(!mult) transformPoint(false,output.alphaUv);
    cell[index*2]=transform[offset+5];cell[index*2+1]=transform[offset+6];
}
function copyVertex(output:RibbonArrays,index:number,position:Vector3,color:Float32Array,colorAt:number,lookup:Float32Array,lookupAt:number,erosion:number):void {
    output.position[index*3]=position.x*AXIS_SIGN[0];output.position[index*3+1]=position.y*AXIS_SIGN[1];output.position[index*3+2]=position.z*AXIS_SIGN[2];
    for(let channel=0;channel<4;channel++) output.tint[index*4+channel]=color[colorAt+channel];
    output.lookup[index*2]=lookup[lookupAt];output.lookup[index*2+1]=lookup[lookupAt+1];output.erode[index]=erosion;
}
function perpendicular(direction:Vector3,output:Vector3):void {
    const magnitudes=[Math.abs(direction.x),Math.abs(direction.y),Math.abs(direction.z)];
    const axis=magnitudes.indexOf(Math.min(...magnitudes));
    const reference=new Vector3(Number(axis===0),Number(axis===1),Number(axis===2));
    Vector3.CrossToRef(direction,reference,output);
    if(output.lengthSquared()===0) output.copyFrom(reference);
    else output.normalize();
}
function trailPoint(source:Strand,index:number,filtered:boolean,output:Vector3):void {
    if(!filtered) {Vector3.FromArrayToRef(source.position,index*3,output);return;}
    const first=Math.max(0,index-3),last=Math.min(source.count-1,index+3);
    output.setAll(0);
    for(let point=first;point<=last;point++) {
        output.x=Math.fround(output.x+source.position[point*3]);
        output.y=Math.fround(output.y+source.position[point*3+1]);
        output.z=Math.fround(output.z+source.position[point*3+2]);
    }
    output.scaleInPlace(1/(last-first+1));
    output.set(Math.fround(output.x),Math.fround(output.y),Math.fround(output.z));
}
export function writeTrail(source:Strand,options:TrailBuild,output:RibbonArrays,cursor:Cursor):void {
    if(source.count<2 || (cursor.vertex+source.count*2)*3>output.position.length || cursor.index+(source.count-1)*6>output.index.length) return;
    const reverse=options.smoothing!==TRAIL_SMOOTHING.backToFront;
    const filter=options.smoothing!==TRAIL_SMOOTHING.off;
    const step=reverse?-1:1;
    const point=Vector3.Zero(),last=Vector3.Zero(),tangent=Vector3.Zero(),across=Vector3.Zero(),previousSide=Vector3.Zero(),raw=Vector3.Zero(),vertex=Vector3.Zero();
    const view=options.view?Vector3.FromArray(options.view):null;
    let distance=0,originU=0,emitted=0;
    for(let ordinal=0;ordinal<source.count;ordinal++) {
        const index=reverse?source.count-1-ordinal:ordinal;
        trailPoint(source,index,filter && ordinal>0 && index!==0,point);
        if(ordinal>0) {
            distance+=Vector3.Distance(point,last);
            if(options.cutoff>0 && distance>=options.cutoff) break;
            point.subtractToRef(last,tangent);
        } else {
            trailPoint(source,index+step,false,tangent);
            tangent.subtractInPlace(point);
        }
        tangent.normalize();
        if(view) {
            Vector3.CrossToRef(view,tangent,across);
            if(across.lengthSquared()>0) across.normalize();
            else if(ordinal) across.copyFrom(previousSide);
            else perpendicular(view,across);
        } else Vector3.FromArrayToRef(source.side,index*3,across);
        raw.copyFrom(across);
        if(filter && ordinal) {
            across.addInPlace(previousSide);
            if(across.lengthSquared()>0) across.normalize();else across.copyFrom(raw);
        }
        const width=source.width[index],tileU=source.tiling[index*2],tileV=source.tiling[index*2+1];
        let u=tileU>0?(options.wake?source.odometer[index]:distance)/tileU:0;
        if(!ordinal) originU=u-u%2;
        u-=originU;
        const span=tileV>0?width/tileV:tileV===0?1:-tileV;
        const base=cursor.vertex+emitted*2;
        for(let edge=0;edge<2;edge++) {
            point.addToRef(across.scale((edge===0?1:-1)*width),vertex);
            const v=0.5+(edge===0?-1:1)*span/2;
            copyVertex(output,base+edge,vertex,source.color,index*4,source.lookup,index*2,source.erode[index]);
            textureCoordinates(output,base+edge,u,v,source.uv,index*UV_STRIDE,options.layers.base);
            if(options.layers.mult) textureCoordinates(output,base+edge,u,v,source.multUv,index*UV_STRIDE,options.layers.mult,true);
        }
        if(emitted) {output.index.set([base,base-2,base-1,base,base-1,base+1],cursor.index);cursor.index+=6;}
        emitted++;last.copyFrom(point);previousSide.copyFrom(raw);
    }
    cursor.vertex+=emitted*2;
}
export function writeBeam(ends:BeamEnds,particle:BeamParticle,layers:RibbonLayers,output:RibbonArrays,cursor:Cursor):void {
    if((cursor.vertex+4)*3>output.position.length || cursor.index+6>output.index.length) return;
    const source=Vector3.FromArray(ends.source),target=Vector3.FromArray(ends.target),delta=target.subtract(source),across=Vector3.Zero();
    const length=delta.length();
    if(ends.eye) {
        const toward=Vector3.FromArray(ends.eye).subtractInPlace(source);
        Vector3.CrossToRef(toward,delta,across);
        if(across.lengthSquared()>0) across.normalize();else perpendicular(toward,across);
    } else {
        const direction=Float32Array.of(length?-delta.z/length:0,0,length?delta.x/length:0);
        turnInto(particle.turn,direction,0);
        across.set(direction[0]+particle.local[0],direction[1]+particle.local[1],direction[2]+particle.local[2]);
    }
    const width=particle.scale[0],tileU=particle.tiling[particle.tilingAt],tileV=particle.tiling[particle.tilingAt+1];
    const extentU=tileU>0?width/tileU:1,extentV=tileV>0?length/tileV:1;
    const corners=[[0,0,-1],[1,0,1],[1,1,1],[0,1,-1]];
    for(let corner=0;corner<4;corner++) {
        const [u,v,sign]=corners[corner];
        const point=(v?source:target).add(delta.scale(v?particle.scale[1]:-particle.scale[2])).addInPlace(across.scale(sign*width/2));
        point.set(Math.fround(point.x),Math.fround(point.y),Math.fround(point.z));
        const index=cursor.vertex+corner;
        copyVertex(output,index,point,particle.color,0,particle.lookup,0,particle.erode);
        textureCoordinates(output,index,v*extentV,u*extentU,particle.uv,particle.uvAt,layers.base,false,true);
        if(layers.mult) textureCoordinates(output,index,v*extentV,u*extentU,particle.multUv,0,layers.mult,true,true);
    }
    output.index.set([0,1,2,0,2,3].map(index=>index+cursor.vertex),cursor.index);
    cursor.vertex+=4;cursor.index+=6;
}

type VertexAttributes = {[K in keyof typeof vertexWidths]:AttributeData};
export type RibbonBuffers = VertexAttributes & {geometry:GeometryData;edgeGeometry:GeometryData;arrays:RibbonArrays;index:AttributeData;edges:AttributeData;shadow:Uint32Array;taken:{index:number}};
export function ribbonBuffers(vertices:number):RibbonBuffers {
    const arrays=Object.fromEntries(Object.entries(vertexWidths).map(([name,width])=>[name,new Float32Array(vertices*width)])) as unknown as RibbonArrays;
    const count=Math.max(vertices-2,0)*3;
    arrays.index=new Uint32Array(count);arrays.edges=new Uint32Array(count*2);
    const geometry=new GeometryData(),edgeGeometry=new GeometryData();
    const attributes=Object.fromEntries(Object.entries(vertexWidths).map(([name,width])=>{
        const attribute=new AttributeData(arrays[name as keyof VertexColumns],width).setUsage(DynamicDrawUsage);
        geometry.setAttribute(name,attribute);edgeGeometry.setAttribute(name,attribute);return [name,attribute];
    })) as VertexAttributes;
    const index=new AttributeData(arrays.index,1).setUsage(DynamicDrawUsage),edges=new AttributeData(arrays.edges,1).setUsage(DynamicDrawUsage);
    geometry.setIndex(index);edgeGeometry.setIndex(edges);geometry.setDrawRange(0,0);edgeGeometry.setDrawRange(0,0);
    return {...attributes,geometry,edgeGeometry,arrays,index,edges,shadow:new Uint32Array(count),taken:{index:-1}};
}
export function commitRibbon(buffers:RibbonBuffers,cursor:Cursor):void {
    if(cursor.vertex) for(const name of Object.keys(vertexWidths) as (keyof VertexColumns)[]) written(buffers[name],cursor.vertex);
    let changed=buffers.taken.index!==cursor.index;
    for(let index=0;index<cursor.index && !changed;index++) changed=buffers.shadow[index]!==buffers.arrays.index[index];
    if(changed) {
        buffers.taken.index=cursor.index;
        buffers.shadow.set(buffers.arrays.index.subarray(0,cursor.index));
        for(let triangle=0;triangle<cursor.index;triangle+=3) {
            for(let corner=0;corner<3;corner++) {
                buffers.arrays.edges[triangle*2+corner*2]=buffers.arrays.index[triangle+corner];
                buffers.arrays.edges[triangle*2+corner*2+1]=buffers.arrays.index[triangle+(corner+1)%3];
            }
        }
        if(cursor.index) {written(buffers.index,cursor.index);written(buffers.edges,cursor.index*2);}
    }
    buffers.geometry.setDrawRange(0,cursor.index);buffers.edgeGeometry.setDrawRange(0,cursor.index*2);
}

