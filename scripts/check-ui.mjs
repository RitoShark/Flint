import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const failures = [];
const files = fs.readdirSync('src', { recursive: true });
const entry = fs.readFileSync('src/styles/index.css', 'utf8');
for (const line of entry.split(/\r?\n/).filter(Boolean)) {
  if (!/^@import ['"].+\.css['"];$/.test(line)) failures.push('styles/index.css must only import stylesheet modules');
}
for (const file of files.filter(file => file.endsWith('.css'))) {
  if (!file.startsWith(`styles${path.sep}`) && !file.startsWith(`themes${path.sep}`)) failures.push(`${file}: put styles under src/styles`);
  const css = fs.readFileSync(path.join('src', file), 'utf8');
  if (css.split(/\r?\n/).length > 1000) failures.push(`${file}: exceeds the 1,000-line module budget`);
  if (/\.dl-btn\b/.test(css)) failures.push(`${file}: use the shared Button styles`);
}
for (const file of files.filter(file => file.endsWith('.tsx'))) {
  const source = fs.readFileSync(path.join('src', file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const report = (node, message) => failures.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${message}`);
  function visit(node) {
    if (ts.isImportDeclaration(node) && /\.css$/.test(node.moduleSpecifier.text)) {
      if (file !== 'main.tsx' || node.moduleSpecifier.text !== './styles/index.css') report(node, 'load CSS through styles/index.css');
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(ast);
      const attributes = node.attributes.properties;
      if (tag === 'DlButton' || tag === 'DlIconButton') report(node, 'use Button or IconButton');
      const className = attributes.find(attribute => attribute.name?.getText(ast) === 'className');
      if (tag === 'button' && /(?<![\w-])(?:dl-)?btn(?:--|[\s"'`])/.test(className?.getText(ast) ?? '')) report(node, 'use <Button> for styled actions');
      if (tag === 'Button' || tag === 'IconButton') {
        const style = attributes.find(attribute => attribute.name?.getText(ast) === 'style');
        const expression = style?.initializer?.expression;
        if (expression && ts.isObjectLiteralExpression(expression)) {
          for (const property of expression.properties) {
            if (property.name && /^(background.*|border.*|color|font.*|padding.*|height|minHeight|maxHeight|opacity)$/.test(property.name.getText(ast))) {
              report(property, 'use Button variants and sizes; inline styles are for placement');
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('UI checks passed: shared buttons, one CSS entry, bounded stylesheet modules.');
}
