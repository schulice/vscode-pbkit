import * as vscode from "vscode";
import { parse } from "@pbkit/pb-cli/esm/core/parser/proto.js";
import {
  stringifyFullIdent,
  stringifyType,
} from "@pbkit/pb-cli/esm/core/schema/stringify-ast-frag.js";

type Parser = {
  offsetToColRow(offset: number): { col: number; row: number };
};

type Token = {
  end: number;
  start: number;
  text: string;
};

type Node = {
  end: number;
  start: number;
  type: string;
  [key: string]: any;
};

export function registerProtoDocumentSymbolProvider(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      [{ language: "proto" }],
      {
        provideDocumentSymbols(document) {
          try {
            const parseResult = parse(document.getText());
            return collectTopLevelSymbols(parseResult.ast.statements, parseResult.parser);
          } catch {
            return [];
          }
        },
      },
    ),
  );
}

function collectTopLevelSymbols(
  statements: Node[],
  parser: Parser,
): vscode.DocumentSymbol[] {
  return statements.flatMap((statement) => {
    const symbol = toTopLevelSymbol(statement, parser);
    return symbol ? [symbol] : [];
  });
}

function toTopLevelSymbol(
  statement: Node,
  parser: Parser,
): vscode.DocumentSymbol | undefined {
  switch (statement.type) {
    case "package":
      return createSymbol(
        stringifyFullIdent(statement.fullIdent),
        vscode.SymbolKind.Namespace,
        statement,
        statement.fullIdent,
        parser,
      );
    case "message":
      return createMessageSymbol(statement, parser);
    case "enum":
      return createEnumSymbol(statement, parser);
    case "service":
      return createServiceSymbol(statement, parser);
    case "extend":
      return createExtendSymbol(statement, parser);
    default:
      return;
  }
}

function createMessageSymbol(
  node: Node,
  parser: Parser,
): vscode.DocumentSymbol {
  return createSymbol(
    node.messageName.text,
    vscode.SymbolKind.Class,
    node,
    node.messageName,
    parser,
    collectMessageBodySymbols(node.messageBody.statements, parser),
  );
}

function createEnumSymbol(
  node: Node,
  parser: Parser,
): vscode.DocumentSymbol {
  const children = node.enumBody.statements.flatMap((statement: Node) => {
    const symbol = statement.type === "enum-field"
      ? createSymbol(
        statement.fieldName.text,
        vscode.SymbolKind.EnumMember,
        statement,
        statement.fieldName,
        parser,
      )
      : undefined;

    return symbol ? [symbol] : [];
  });

  return createSymbol(
    node.enumName.text,
    vscode.SymbolKind.Enum,
    node,
    node.enumName,
    parser,
    children,
  );
}

function createServiceSymbol(
  node: Node,
  parser: Parser,
): vscode.DocumentSymbol {
  const children = node.serviceBody.statements.flatMap((statement: Node) => {
    if (statement.type !== "rpc") {
      return [];
    }

    const reqType = formatRpcType(statement.reqType);
    const resType = formatRpcType(statement.resType);
    return [createSymbol(
      statement.rpcName.text,
      vscode.SymbolKind.Method,
      statement,
      statement.rpcName,
      parser,
      [],
      `${reqType} -> ${resType}`,
    )];
  });

  return createSymbol(
    node.serviceName.text,
    vscode.SymbolKind.Interface,
    node,
    node.serviceName,
    parser,
    children,
  );
}

function createExtendSymbol(
  node: Node,
  parser: Parser,
): vscode.DocumentSymbol {
  const children = node.extendBody.statements.flatMap((statement: Node) => {
    const symbol = toMessageBodySymbol(statement, parser);
    return symbol ? [symbol] : [];
  });

  return createSymbol(
    `extend ${stringifyType(node.messageType)}`,
    vscode.SymbolKind.Object,
    node,
    node.messageType,
    parser,
    children,
  );
}

function collectMessageBodySymbols(
  statements: Node[],
  parser: Parser,
): vscode.DocumentSymbol[] {
  return statements.flatMap((statement) => {
    const symbol = toMessageBodySymbol(statement, parser);
    return symbol ? [symbol] : [];
  });
}

function toMessageBodySymbol(
  statement: Node,
  parser: Parser,
): vscode.DocumentSymbol | undefined {
  switch (statement.type) {
    case "field":
      return createFieldSymbol(
        statement.fieldName?.text,
        statement,
        statement.fieldName,
        parser,
      );
    case "malformed-field":
      if (!statement.fieldName) {
        return;
      }
      return createFieldSymbol(
        statement.fieldName.text,
        statement,
        statement.fieldName,
        parser,
      );
    case "map-field":
      return createSymbol(
        statement.mapName.text,
        vscode.SymbolKind.Field,
        statement,
        statement.mapName,
        parser,
        [],
        `map<${stringifyType(statement.keyType)}, ${stringifyType(statement.valueType)}> = ${statement.fieldNumber.text}`,
      );
    case "group":
      return createSymbol(
        statement.groupName.text,
        vscode.SymbolKind.Struct,
        statement,
        statement.groupName,
        parser,
        collectMessageBodySymbols(statement.messageBody.statements, parser),
      );
    case "oneof":
      return createSymbol(
        statement.oneofName.text,
        vscode.SymbolKind.Field,
        statement,
        statement.oneofName,
        parser,
        statement.oneofBody.statements.flatMap((child: Node) => {
          if (child.type !== "oneof-field") {
            return [];
          }

          return [createFieldSymbol(
            child.fieldName.text,
            child,
            child.fieldName,
            parser,
          )];
        }),
      );
    case "message":
      return createMessageSymbol(statement, parser);
    case "enum":
      return createEnumSymbol(statement, parser);
    case "extend":
      return createExtendSymbol(statement, parser);
    default:
      return;
  }
}

function createFieldSymbol(
  name: string | undefined,
  node: Node,
  selectionNode: Token | undefined,
  parser: Parser,
): vscode.DocumentSymbol | undefined {
  if (!name || !selectionNode) {
    return;
  }

  const fieldType = node.fieldType ? stringifyType(node.fieldType) : "";
  const fieldNumber = node.fieldNumber ? formatSignedInt(node.fieldNumber) : "";
  const detail = fieldType
    ? `${fieldType}${fieldNumber ? ` = ${fieldNumber}` : ""}`
    : undefined;

  return createSymbol(
    name,
    vscode.SymbolKind.Field,
    node,
    selectionNode,
    parser,
    [],
    detail,
  );
}

function createSymbol(
  name: string,
  kind: vscode.SymbolKind,
  node: Node,
  selectionNode: Node,
  parser: Parser,
  children: vscode.DocumentSymbol[] = [],
  detail?: string,
): vscode.DocumentSymbol {
  const symbol = new vscode.DocumentSymbol(
    name,
    detail ?? "",
    kind,
    toRange(node, parser),
    toRange(selectionNode, parser),
  );
  symbol.children = children;
  return symbol;
}

function formatRpcType(node: Node): string {
  const streamPrefix = node.stream ? `${node.stream.text} ` : "";
  return `${streamPrefix}${stringifyType(node.messageType)}`;
}

function formatSignedInt(node: Node): string {
  const sign = node.sign?.text ?? "";
  const value = node.text ?? node.value?.text ?? "";
  return `${sign}${value}`;
}

function toRange(node: Node, parser: Parser): vscode.Range {
  const start = parser.offsetToColRow(node.start);
  const end = parser.offsetToColRow(node.end);
  return new vscode.Range(start.row, start.col, end.row, end.col);
}
