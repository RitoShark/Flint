import React from 'react';

export interface ChromaPreviewData {
    url: string;
    name: string;
    c1: string;
    c2?: string;
    anchorX: number;
    anchorY: number;
}
export const ChromaPreviewPopup: React.FC<{ data: ChromaPreviewData }> = ({ data }) => {
    const W = 200;
    const H = 244;
    const GAP = 12;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    let left = Math.round(data.anchorX - W / 2);
    left = Math.max(8, Math.min(vpW - W - 8, left));
    const above = data.anchorY - GAP - H;
    const top = above >= 8 ? above : Math.min(vpH - H - 8, data.anchorY + 36 + GAP);
    return (
        <div className="np-chroma-preview" style={{ left, top, width: W }}>
            <div className="np-chroma-preview__img-wrap">
                <img src={data.url} alt={data.name} draggable={false} />
            </div>
            <div className="np-chroma-preview__meta">
                <div className="np-chroma-preview__name">{data.name}</div>
                <div className="np-chroma-preview__swatches">
                    <span className="np-chroma-preview__chip" style={{ background: data.c1 }} />
                    {data.c2 && <span className="np-chroma-preview__chip" style={{ background: data.c2 }} />}
                </div>
            </div>
        </div>
    );
};
