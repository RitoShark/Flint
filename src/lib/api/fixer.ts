import { invokeCommand } from './core';
import type { FixConfig, ProjectAnalysis, ProjectFixResult, BatchFixResult } from '../types';

export async function getFixerConfig(): Promise<FixConfig> {
    return invokeCommand('get_fixer_config');
}

export async function analyzeProject(projectPath: string): Promise<ProjectAnalysis> {
    return invokeCommand('analyze_project', { projectPath });
}

export async function fixProject(
    projectPath: string,
    selectedFixIds: string[] = []
): Promise<ProjectFixResult> {
    return invokeCommand('fix_project', { projectPath, selectedFixIds });
}

export async function batchFixProjects(
    projectPaths: string[],
    selectedFixIds: string[] = []
): Promise<BatchFixResult> {
    return invokeCommand('batch_fix_projects', { projectPaths, selectedFixIds });
}
