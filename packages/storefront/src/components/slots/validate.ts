// A17: build-time validation of one slot file. Used by vite-plugin.ts (fails the build) and by the unit tests. Node only:
// never import this from app code (it pulls in the TypeScript compiler).
import ts from 'typescript';
import { isSlotName, slotNameFromFile, SLOT_FILE_EXTENSION } from './registry';

export interface SlotProblem {
	file: string;
	message: string;
}

const QWIK_CORE = '@qwik.dev/core';

/** Names the file binds to `component$` imported from @qwik.dev/core (alias-aware). */
function componentBindings(sf: ts.SourceFile): Set<string> {
	const names = new Set<string>();
	for (const st of sf.statements) {
		if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== QWIK_CORE) continue;
		const bindings = st.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const el of bindings.elements) {
			if ((el.propertyName ?? el.name).text === 'component$') names.add(el.name.text);
		}
	}
	return names;
}

/** The expression a `export default` resolves to: the expression itself, or the initializer of the top-level const it names. */
function defaultExportExpression(sf: ts.SourceFile): ts.Expression | null {
	let expr: ts.Expression | null = null;
	for (const st of sf.statements) {
		if (ts.isExportAssignment(st) && !st.isExportEquals) expr = st.expression;
	}
	if (!expr) return null;
	if (!ts.isIdentifier(expr)) return expr;
	const target = expr.text;
	for (const st of sf.statements) {
		if (!ts.isVariableStatement(st)) continue;
		for (const d of st.declarationList.declarations) {
			if (ts.isIdentifier(d.name) && d.name.text === target && d.initializer) return d.initializer;
		}
	}
	return null;
}

/** Problems of one slot file: name, `component$` default export, props typed `SlotProps<'<its own name>'>`. */
export function validateSlotFile(fileName: string, text: string): SlotProblem[] {
	const problems: SlotProblem[] = [];
	const add = (message: string) => problems.push({ file: fileName, message });
	const name = slotNameFromFile(fileName);
	if (name === null) {
		add(`slot files must end in ${SLOT_FILE_EXTENSION}`);
		return problems;
	}
	if (!isSlotName(name)) {
		add(`unknown slot "${name}" (see SlotPropsMap in src/components/slots/registry.ts)`);
		return problems;
	}
	const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const expr = defaultExportExpression(sf);
	const bound = componentBindings(sf);
	if (!expr || !ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression) || !bound.has(expr.expression.text)) {
		add(`the default export of ${fileName} must be component$(...) imported from ${QWIK_CORE}`);
		return problems;
	}
	const typeArg = expr.typeArguments?.[0];
	const ok =
		!!typeArg &&
		ts.isTypeReferenceNode(typeArg) &&
		ts.isIdentifier(typeArg.typeName) &&
		typeArg.typeName.text === 'SlotProps' &&
		typeArg.typeArguments?.length === 1 &&
		ts.isLiteralTypeNode(typeArg.typeArguments[0]) &&
		ts.isStringLiteral(typeArg.typeArguments[0].literal) &&
		typeArg.typeArguments[0].literal.text === name;
	if (!ok) add(`component$ in ${fileName} must be typed component$<SlotProps<'${name}'>>(...) so its props come from the registry`);
	return problems;
}
