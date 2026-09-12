import { lazy, Suspense } from 'react';
import type { ModelPreviewProps } from './ModelPreview';

const ModelPreview = lazy(() => import('./ModelPreview').then(module => ({ default: module.ModelPreview })));

export default function LazyModelPreview(props: ModelPreviewProps) {
    return (
        <Suspense
            fallback={
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    width: '100%',
                    background: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    fontSize: '14px'
                }}>
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ marginBottom: '8px' }}>🎨</div>
                        <div>Loading 3D viewer...</div>
                    </div>
                </div>
            }
        >
            <ModelPreview {...props} />
        </Suspense>
    );
}
