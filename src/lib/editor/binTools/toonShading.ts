import { appendToList } from './blockInsert';

/** In-WAD paths the bundled ramps are installed at (see `install_toon_ramps`). */
export const TOON_RAMP_PATH = 'assets/jadelib/toon-shading/ToonShading.tex';
export const TOON_OUTLINE_PATH = 'assets/jadelib/toon-shading/OutlineToneMap.tex';

export const TOON_BASE_NAME = 'Toon_Shading';

/** The toon pass' shader object. Same link the League toon materials carry. */
const TOON_SHADER_LINK = '0x54d82cba';

export type Rgb = [number, number, number];

export interface ToonMaterialOptions {
    name: string;
    /** In-WAD path of the submesh's own diffuse texture. */
    diffusePath: string;
    shadePower: number;
    outline: boolean;
    outlineWidth: number;
    outlineColor: Rgb;
    rim: boolean;
    rimColor: Rgb;
    rimStrength: number;
}

export const TOON_DEFAULTS: Omit<ToonMaterialOptions, 'name' | 'diffusePath'> = {
    shadePower: 8.4,
    outline: false,
    outlineWidth: 0.25,
    outlineColor: [0, 0, 0],
    rim: true,
    rimColor: [0.015, 0.549, 0.344],
    rimStrength: 1,
};

const INDENT = '    ';

function num(v: number): string {
    if (!isFinite(v)) return '0';
    const s = v.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
    return s === '' || s === '-0' ? '0' : s;
}

function vec4(a: number, b: number, c: number, d: number): string {
    return `{ ${num(a)}, ${num(b)}, ${num(c)}, ${num(d)} }`;
}

/**
 * Namespaced the way the animated loadscreen banner names its material:
 * `<Champion>/<Project>/Materials/<Project>_Toon_<Submesh>`.
 *
 * The game merges `StaticMaterialDef`s by name across every enabled mod, so two
 * mods sharing a name means one of them silently loses its material. Scoping by
 * champion + project makes that collision impossible between mods, and the
 * submesh keeps a project's own toon materials apart.
 */
export function toonMaterialName(
    champion: string,
    project: string,
    submesh: string,
    text = '',
): string {
    const proj = project.replace(/\s+/g, '') || 'Mod';
    const champ = champion.trim() || 'Skin';
    const mesh = submesh.replace(/[^A-Za-z0-9_]/g, '');
    const base = `${champ}/${proj}/Materials/${proj}_${TOON_BASE_NAME}${mesh ? `_${mesh}` : ''}`;
    if (!text.includes(`"${base}"`)) return base;
    let n = 2;
    while (text.includes(`"${base}_${n}"`)) n++;
    return `${base}_${n}`;
}

function sampler(indent: string, textureName: string, path: string): string[] {
    return [
        `${indent}StaticMaterialShaderSamplerDef {`,
        `${indent}${INDENT}TextureName: string = "${textureName}"`,
        // `file`, not `string`: Riot retyped texturePath, and a string here is a
        // reference the current client no longer resolves.
        `${indent}${INDENT}texturePath: file = "${path}"`,
        `${indent}${INDENT}AddressU: u32 = 1`,
        `${indent}${INDENT}AddressV: u32 = 1`,
        `${indent}${INDENT}AddressW: u32 = 1`,
        `${indent}}`,
    ];
}

function param(indent: string, name: string, value: string): string[] {
    return [
        `${indent}StaticMaterialShaderParamDef {`,
        `${indent}${INDENT}Name: string = "${name}"`,
        `${indent}${INDENT}Value: vec4 = ${value}`,
        `${indent}}`,
    ];
}

/** The `"<name>" = StaticMaterialDef { … }` block, indented to sit in `entries`. */
export function buildToonMaterial(indent: string, o: ToonMaterialOptions): string[] {
    const i1 = indent + INDENT;
    const i2 = i1 + INDENT;
    const i3 = i2 + INDENT;
    const i4 = i3 + INDENT;

    const [or, og, ob] = o.outlineColor;
    const [rr, rg, rb] = o.rimColor;

    const switches: string[] = [];
    if (o.rim) switches.push('RIM_COLOR_ON');
    if (o.outline) switches.push('OUTLINE_ON');

    return [
        `${indent}"${o.name}" = StaticMaterialDef {`,
        `${i1}Name: string = "${o.name}"`,
        `${i1}SamplerValues: list2[embed] = {`,
        ...sampler(i2, 'Diffuse_Texture', o.diffusePath),
        ...sampler(i2, 'ToonShadingTex', TOON_RAMP_PATH),
        ...sampler(i2, 'ToonShadingOutlineTex', TOON_OUTLINE_PATH),
        `${i1}}`,
        `${i1}ParamValues: list2[embed] = {`,
        ...param(i2, 'ToonShadePower', vec4(o.shadePower, 0, 0, 0)),
        ...param(i2, 'ToonOutlineControl', o.outline ? vec4(1, o.outlineWidth, 0.1, 0) : vec4(0, 0, 0, 0)),
        ...param(i2, 'ToonRimControl', o.rim ? vec4(1, 0.3, 0.1, 0) : vec4(0, 0, 0, 0)),
        ...param(i2, 'TintColorBase', vec4(1, 1, 1, 1)),
        ...param(i2, 'TintColorOutline', vec4(or, og, ob, 1)),
        ...param(i2, 'TintColorRim', vec4(rr, rg, rb, 0.5)),
        ...param(i2, 'Rim_Color_Strength', vec4(o.rimStrength, 0, 0, 0)),
        `${i1}}`,
        `${i1}Switches: list2[embed] = {`,
        ...switches.flatMap((name) => [
            `${i2}StaticMaterialSwitchDef {`,
            `${i2}${INDENT}Name: string = "${name}"`,
            `${i2}}`,
        ]),
        `${i1}}`,
        `${i1}ShaderMacros: map[string,string] = {`,
        `${i2}"NUM_BLEND_WEIGHTS" = "4"`,
        `${i1}}`,
        `${i1}Techniques: list[embed] = {`,
        `${i2}StaticMaterialTechniqueDef {`,
        `${i3}Name: string = "normal"`,
        `${i3}Passes: list[embed] = {`,
        `${i4}StaticMaterialPassDef {`,
        `${i4}${INDENT}Shader: link = ${TOON_SHADER_LINK}`,
        `${i4}${INDENT}BlendEnable: bool = true`,
        `${i4}${INDENT}SrcColorBlendFactor: u32 = 6`,
        `${i4}${INDENT}SrcAlphaBlendFactor: u32 = 6`,
        `${i4}${INDENT}DstColorBlendFactor: u32 = 7`,
        `${i4}${INDENT}DstAlphaBlendFactor: u32 = 7`,
        `${i4}}`,
        `${i3}}`,
        `${i2}}`,
        `${i1}}`,
        `${i1}ChildTechniques: list[embed] = {`,
        `${i2}StaticMaterialChildTechniqueDef {`,
        `${i3}Name: string = "transition"`,
        `${i3}ParentName: string = "normal"`,
        `${i3}ShaderMacros: map[string,string] = {`,
        `${i4}"TRANSITION" = "1"`,
        `${i3}}`,
        `${i2}}`,
        `${i1}}`,
        `${indent}}`,
    ];
}

/** Append the material to the bin's `entries` map. Returns the text unchanged
 *  when there is no entries block to append to. */
export function insertToonMaterial(text: string, o: ToonMaterialOptions): string {
    return appendToList(
        text,
        { name: 'entries', decl: 'map[hash,embed]', container: /^#PROP_text/ },
        (indent) => buildToonMaterial(indent, o),
    );
}

const SAMPLER_BLOCK = /StaticMaterialShaderSamplerDef\s*\{([^}]*)\}/g;
const DIFFUSE_NAMES = /(?:Diffuse_Texture|DiffuseTexture|Main_Texture|MainTexture)/i;

/** Diffuse texture paths already referenced by this bin, newest-first duplicates
 *  removed — what a toon material's own diffuse slot should normally point at. */
export function findDiffusePaths(text: string): string[] {
    const found = new Set<string>();
    SAMPLER_BLOCK.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SAMPLER_BLOCK.exec(text)) !== null) {
        const body = m[1];
        const name = /TextureName\s*:\s*string\s*=\s*"([^"]*)"/i.exec(body)?.[1] ?? '';
        if (!DIFFUSE_NAMES.test(name)) continue;
        const path = /texturePath\s*:\s*(?:file|string)\s*=\s*"([^"]*)"/i.exec(body)?.[1];
        if (path && path !== TOON_RAMP_PATH && path !== TOON_OUTLINE_PATH) found.add(path);
    }
    return [...found];
}

export function hasToonMaterial(text: string): boolean {
    return /"[^"]*toon_shading[^"]*"\s*=\s*StaticMaterialDef/i.test(text);
}
