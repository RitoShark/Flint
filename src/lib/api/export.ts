import { invokeCommand } from './core';

interface ExportMetadata {
    name: string;
    author: string;
    version: string;
    description: string;
}

interface ExportParams {
    projectPath: string;
    outputPath: string;
    format: 'fantome' | 'modpkg';
    champion: string;
    metadata: ExportMetadata;
}

export async function exportProject(params: ExportParams): Promise<{ path: string }> {
    if (params.format === 'fantome') {
        return invokeCommand('export_fantome', {
            projectPath: params.projectPath,
            outputPath: params.outputPath,
            champion: params.champion,
            metadata: params.metadata,
            autoRepath: true,
        });
    }
    return invokeCommand('export_modpkg', {
        projectPath: params.projectPath,
        outputPath: params.outputPath,
    });
}
