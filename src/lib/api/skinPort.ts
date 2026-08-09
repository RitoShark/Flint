import { invokeCommand } from './core';

export interface PortOutcome {
    written: number[];
    skipped: number[];
}

export async function portProjectToJade(
    projectPath: string,
    champion: string,
    sourceSkinId: number,
    targets: number[],
): Promise<PortOutcome> {
    return invokeCommand('port_project_to_jade', {
        projectPath,
        champion,
        sourceSkinId,
        targets,
    });
}

export async function portProjectNoSkinLite(
    projectPath: string,
    champion: string,
    sourceSkinId: number,
    targets: number[],
): Promise<PortOutcome> {
    return invokeCommand('port_project_no_skin_lite', {
        projectPath,
        champion,
        sourceSkinId,
        targets,
    });
}
