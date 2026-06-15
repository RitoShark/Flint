import { lazy, Suspense } from 'react';

const BinEditor = lazy(() => import('./BinEditor').then(module => ({ default: module.BinEditor })));

interface LazyBinEditorProps {
    filePath: string;
}

export default function LazyBinEditor(props: LazyBinEditorProps) {
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
                        <div style={{ marginBottom: '8px' }}>⏳</div>
                        <div>Loading editor...</div>
                    </div>
                </div>
            }
        >
            <BinEditor {...props} />
        </Suspense>
    );
}
