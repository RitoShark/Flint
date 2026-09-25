import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../',import.meta.url));
const bundle = await build({absWorkingDir:root,entryPoints:['scripts/vfx-smoke.ts'],bundle:true,format:'esm',write:false,metafile:true,jsx:'automatic',alias:{'@':root+'src'},define:{'process.env.NODE_ENV':'"development"','import.meta.env.DEV':'false'}});
assert.ok(!Object.keys(bundle.metafile.inputs).some(path=>/node_modules\/(three|@react-three)\//.test(path)), 'The particle runtime must not import Three.js or Fiber');
const server = createServer((req,res)=>{
    res.setHeader('Content-Type', req.url === '/smoke.js' ? 'application/javascript' : 'text/html');
    res.end(req.url === '/smoke.js' ? bundle.outputFiles[0].contents : '<canvas width="256" height="256"></canvas><script type="module" src="/smoke.js"></script>');
});
await new Promise(resolve=>server.listen(1423,'127.0.0.1',resolve));
console.log('VFX test server ready');
const browser = await chromium.launch({channel:'chromium',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist'],timeout:30000});
console.log('VFX test browser ready');
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    const errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    page.on('console',message=>{if(message.type()==='error'||/GL_INVALID|INVALID_OPERATION|incomplete framebuffer/i.test(message.text())) errors.push(message.text());});
    await page.goto('http://localhost:1423/scripts/vfx-smoke.html');
    console.log('VFX test page loaded');
    await page.waitForFunction(()=>window.vfxSmoke,{timeout:60000});
    const result=await page.evaluate(async()=>{const t=window.vfxSmoke;t.open();return await t.frames();});
    console.log('quad and depth',result);
    assert.ok(result.red>500,'Particles must draw beyond the occluder');
    assert.ok(result.center[1]>100 && result.center[0]<50,'Champion must occlude particles behind it');
    assert.equal(result.glError,0);
    const soft=await page.evaluate(async()=>{const t=window.vfxSmoke;t.open(undefined,{softParticleParams:t.struct('VfxSoftParticleDefinitionData',{beginIn:t.number(0),deltaIn:t.number(10)})});return await t.frames();});
    console.log('soft depth and remount',soft); assert.equal(soft.glError,0); assert.ok(soft.red>100);
    const warp=await page.evaluate(async()=>{const t=window.vfxSmoke;t.open(undefined,{distortionDefinition:t.struct('VfxDistortionDefinitionData',{normalMapTexture:t.asset,distortion:t.number(0.1)})});return await t.frames();});
    console.log('distortion',warp); assert.equal(warp.glError,0);
    for(const primitive of ['VfxPrimitiveArbitraryQuad','VfxPrimitiveRay','VfxPrimitiveCameraTrail','VfxPrimitiveArbitraryTrail','VfxPrimitiveBeam','VfxPrimitiveCameraSegmentBeam','VfxPrimitiveMesh','VfxPrimitiveAttachedMesh']) {
        const drawn=await page.evaluate(async primitive=>{
            const t=window.vfxSmoke;
            const extra={};
            if(primitive.includes('Trail')) {extra.birthVelocity=t.constant(t.vector(120,0,0));extra.birthScale0=t.constant(t.vector(12,12,12));}
            if(primitive==='VfxPrimitiveArbitraryTrail') extra.birthVelocity=t.constant(t.vector(0,120,0));
            if(primitive.includes('Beam')) extra.birthScale0=t.constant(t.vector(12,12,12));
            if(primitive==='VfxPrimitiveRay') {extra.birthRotation0=t.constant(t.vector(0,60,0));extra.birthScale0=t.constant(t.vector(40,180,0));}
            if(primitive==='VfxPrimitiveMesh') {
                extra.primitive=t.struct(primitive,{mMesh:t.struct('VfxMeshDefinitionData',{mSimpleMeshName:{...t.asset,path:'cube.scb'}})});
                extra.birthScale0=t.constant(t.vector(2,2,2));extra.disableBackfaceCull={type:'bool',value:true};
            }
            if(primitive==='VfxPrimitiveAttachedMesh') extra.birthScale0=t.constant(t.vector(1.2,1.2,1.2));
            t.open(primitive,extra);return t.frames(120);
        },primitive);
        console.log(primitive,drawn);
        assert.equal(drawn.glError,0); assert.ok(drawn.red>30,primitive+' must produce visible pixels');assert.deepEqual(drawn.warnings,[]);
    }
    const playback=await page.evaluate(async()=>{
        const t=window.vfxSmoke;t.open(undefined,{birthVelocity:t.constant(t.vector(80,0,0)),birthScale0:t.constant(t.vector(12,12,12))});await t.frames();
        t.speed(0);const paused=await t.frames(1),held=await t.frames(10);t.seek(0.5);const first=await t.frames(1);t.seek(1.5);await t.frames(1);t.seek(0.5);const replay=await t.frames(1);
        return {paused:paused.hash,held:held.hash,first:first.hash,replay:replay.hash};
    });
    console.log('pause and deterministic seek',playback);assert.equal(playback.paused,playback.held);assert.equal(playback.first,playback.replay);
    const child=await page.evaluate(async()=>{
        const t=window.vfxSmoke;
        const child=t.struct('VfxSystemDefinitionData',{complexEmitterDefinitionData:{type:'container',items:[t.struct('VfxEmitterDefinitionData',{texture:t.asset,isSingleParticle:{type:'bool',value:true},particleLifetime:t.constant(t.number(3)),birthScale0:t.constant(t.vector(100,100,100)),birthColor:t.constant(t.vector(1,0,0,1))})]}});
        t.open(undefined,{texture:{type:'asset',path:'',asset:null},childParticleSetDefinition:t.struct('VfxChildParticleSetDefinitionData',{childrenIdentifiers:{type:'container',items:[t.struct('VfxChildIdentifier',{effectKey:child})]}})});
        return t.frames(90);
    });
    console.log('child systems',child);assert.equal(child.glError,0);assert.ok(child.red>100);assert.deepEqual(child.warnings,[]);
    const reflection=await page.evaluate(async()=>{
        const t=window.vfxSmoke;t.open('VfxPrimitiveMesh',{
            primitive:t.struct('VfxPrimitiveMesh',{mMesh:t.struct('VfxMeshDefinitionData',{mSimpleMeshName:{...t.asset,path:'cube.scb'}})}),
            birthScale0:t.constant(t.vector(2,2,2)),disableBackfaceCull:{type:'bool',value:true},
            reflectionDefinition:t.struct('VfxReflectionDefinitionData',{reflectionMapTexture:t.asset,reflectionOpacityDirect:t.number(0.1),reflectionOpacityGlancing:t.number(0.1)}),
        });return t.frames();
    });
    console.log('reflection cubemap',reflection);assert.equal(reflection.glError,0);assert.ok(reflection.red>100);assert.deepEqual(reflection.warnings,[]);
    const animated=await page.evaluate(async()=>{
        const t=window.vfxSmoke;
        t.open('VfxPrimitiveMesh',{primitive:t.struct('VfxPrimitiveMesh',{mMesh:t.struct('VfxMeshDefinitionData',{mMeshName:{...t.asset,path:'cube.skn'},mMeshSkeletonName:{...t.asset,path:'cube.skl'},mAnimationName:{...t.asset,path:'cube.anm'}})}),birthScale0:t.constant(t.vector(2,2,2)),disableBackfaceCull:{type:'bool',value:true}});
        await t.frames(90);t.speed(0);t.seek(0.3);const first=await t.frames(1);t.seek(0.7);const later=await t.frames(1);return {first,later};
    });
    console.log('animated mesh',animated);assert.equal(animated.later.glError,0);assert.ok(animated.first.red>100);assert.notEqual(animated.first.hash,animated.later.hash);assert.deepEqual(animated.later.warnings,[]);
    const surface=await page.evaluate(async()=>{const t=window.vfxSmoke;t.open(undefined,{birthScale0:t.constant(t.vector(12,12,12)),emissionSurfaceDefinition:t.struct('VfxEmissionSurfaceData',{meshName:{...t.asset,path:'cube.scb'},meshScale:t.number(3)})});return t.frames(90);});
    console.log('mesh emission surface',surface);assert.equal(surface.glError,0);assert.ok(surface.red>100);assert.deepEqual(surface.warnings,[]);
    const custom=await page.evaluate(async()=>{
        const t=window.vfxSmoke;
        const material=t.struct('StaticMaterialDef',{paramValues:{type:'container',items:[t.struct('StaticMaterialShaderParamDef',{name:{type:'string',value:'TintColor'},value:t.vector(1,0,0,1)})]},techniques:{type:'container',items:[t.struct('StaticMaterialTechniqueDef',{name:{type:'string',value:'normal'},passes:{type:'container',items:[t.struct('StaticMaterialPassDef',{cullEnable:{type:'bool',value:false}})]}})]}});
        material.object={entry:'0x12345679',name:null};
        t.open(undefined,{CustomMaterial:t.struct('VfxMaterialDefinitionData',{Material:material})});return t.frames(90);
    });
    console.log('custom material',custom);assert.equal(custom.glError,0);assert.ok(custom.red>100);assert.deepEqual(custom.warnings,[]);
    const resize=await page.evaluate(async()=>{const t=window.vfxSmoke;t.engine.setSize(320,180);const result=await t.frames(3);const width=document.querySelector('canvas').style.width;t.engine.setSize(256,256);await t.frames(3);return {...result,cssWidth:width};});
    console.log('resize',resize);assert.equal(resize.glError,0);assert.ok(resize.red>100);assert.equal(resize.cssWidth,'');
    const closed=await page.evaluate(async()=>{window.vfxSmoke.dispose();await new Promise(r=>setTimeout(r,700));return window.vfxSmoke.frames(1);});
    console.log('disposed',closed); assert.equal(closed.lost,false); assert.ok(closed.green>100); assert.equal(closed.red,0);
    const lifecycle=await page.evaluate(async()=>{
        const t=window.vfxSmoke;
        const resources=()=>({meshes:t.scene.meshes.length,materials:t.scene.materials.length,textures:t.scene.textures.length,targets:t.scene.customRenderTargets.length});
        const baseline=resources();
        for(let i=0;i<3;i++) {
            t.open(undefined,{softParticleParams:t.struct('VfxSoftParticleDefinitionData',{beginIn:t.number(0),deltaIn:t.number(10)}),distortionDefinition:t.struct('VfxDistortionDefinitionData',{normalMapTexture:t.asset,distortion:t.number(0.1)})});
            await t.frames(20);t.dispose();
        }
        const invoke=window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke=async(...args)=>{await new Promise(r=>setTimeout(r,30));return invoke(...args);};
        t.open();t.dispose();await new Promise(r=>setTimeout(r,200));
        window.__TAURI_INTERNALS__.invoke=invoke;
        return {baseline,after:resources()};
    });
    console.log('resource lifecycle',lifecycle);assert.deepEqual(lifecycle.after,lifecycle.baseline);
    const visibility=await page.evaluate(async()=>{
        const t=window.vfxSmoke;t.open('VfxPrimitiveAttachedMesh',{birthScale0:t.constant(t.vector(1.2,1.2,1.2))});
        const visible=await t.frames(90);t.speed(0);t.hide(['body']);const hidden=await t.frames(1);t.hide([]);const restored=await t.frames(1);t.dispose();return {visible,hidden,restored};
    });
    console.log('attached submesh visibility',visibility);assert.ok(visibility.visible.red>100);assert.equal(visibility.hidden.red,0);assert.equal(visibility.restored.hash,visibility.visible.hash);assert.equal(visibility.restored.glError,0);
    assert.deepEqual(result.warnings,[]); assert.deepEqual(soft.warnings,[]); assert.deepEqual(warp.warnings,[]);
    assert.deepEqual(errors,[]);
} catch(error) { console.error(error); process.exitCode=1; }
finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
