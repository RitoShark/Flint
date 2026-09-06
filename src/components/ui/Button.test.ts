import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, IconButton } from './Button';

describe('Button', () => {
  it('preserves native form semantics and custom content', () => {
    const html = renderToStaticMarkup(createElement(Button, {
      type: 'submit', name: 'action', value: 'save', form: 'editor',
    }, createElement('span', { className: 'label' }, 'Save')));
    expect(html).toContain('type="submit"');
    expect(html).toContain('name="action"');
    expect(html).toContain('form="editor"');
    expect(html).toContain('value="save"');
    expect(html).toContain('><span class="label">Save</span></button>');
  });

  it('makes loading actions unavailable and exposes their busy state', () => {
    const html = renderToStaticMarkup(createElement(Button, { loading: true, disabled: false }, 'Save'));
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('btn__spinner');
    expect(html).toContain('Save');
  });

  it('only exposes pressed state for toggle actions', () => {
    expect(renderToStaticMarkup(createElement(Button, {}, 'Save'))).not.toContain('aria-pressed');
    expect(renderToStaticMarkup(createElement(Button, { active: false }, 'Grid'))).toContain('aria-pressed="false"');
    expect(renderToStaticMarkup(createElement(Button, { active: true }, 'Grid'))).toContain('aria-pressed="true"');
  });

  it('gives icon actions a name and keeps decorative icons out of the accessible name', () => {
    const html = renderToStaticMarkup(createElement(IconButton, { icon: 'settings', title: 'Open settings' }));
    expect(html).toContain('aria-label="Open settings"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('btn--icon');
    expect(html).toContain('type="button"');
  });
});
