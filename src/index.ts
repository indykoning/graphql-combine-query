import { DocumentNode, OperationDefinitionNode, DefinitionNode, FieldNode } from 'graphql'
import { renameVariablesAndTopLevelFields, RenameFnWithIndex, defaultRenameFn, renameVariables } from './utils'

type OperationVariables = Record<string, any>

export interface CombinedQueryBuilderConfig {
  allow_duplicates?: string[],
}

const emptyDoc: DocumentNode = {
  kind: 'Document',
  definitions: []
}

export interface NewCombinedQueryBuilder {
  operationName: string,
  add: <TData = any, TVariables = OperationVariables>(document: DocumentNode, variables?: TVariables, config?: CombinedQueryBuilderConfig) => CombinedQueryBuilder<TData, TVariables>
  addN: <TVariables = OperationVariables>(document: DocumentNode, variables: TVariables[], variableRenameFn?: RenameFnWithIndex, fieldRenameFn?: RenameFnWithIndex ) => CombinedQueryBuilder<{}, {}>
}

export interface CombinedQueryBuilder<TData = any, TVariables extends OperationVariables = {}> {
  document: DocumentNode,
  variables?: TVariables,
  add: <TDataAdd = any, TVariablesAdd = OperationVariables>(document: DocumentNode, variables?: TVariablesAdd, config?: CombinedQueryBuilderConfig) => CombinedQueryBuilder<TData & TDataAdd, TVariables & TVariablesAdd>
  addN: <TVariablesAdd = OperationVariables>(document: DocumentNode, variables: TVariablesAdd[], variableRenameFn?: RenameFnWithIndex, fieldRenameFn?: RenameFnWithIndex) => CombinedQueryBuilder<TData, TVariables>
}

class CombinedQueryError extends Error {}

class CombinedQueryBuilderImpl<TData = any, TVariables = OperationVariables> implements CombinedQueryBuilder<TData, TVariables> {

  document: DocumentNode
  variables?: TVariables
  config?: CombinedQueryBuilderConfig

  constructor(private operationName: string, document: DocumentNode, variables?: TVariables, config?: CombinedQueryBuilderConfig) {
    this.document = document
    this.variables = variables
    this.config = this.initializeConfig(config)
  }

  initializeConfig(config?: CombinedQueryBuilderConfig): CombinedQueryBuilderConfig
  {
    if (!config) {
      config = {}
    }
    config = {...this.config, ...config}

    config.allow_duplicates = config.allow_duplicates ?? [];

    return config;
  }

  add<TDataAdd = any, TVariablesAdd = OperationVariables>(document: DocumentNode, variables?: TVariablesAdd, config?: CombinedQueryBuilderConfig): CombinedQueryBuilder<TData & TDataAdd, TVariables & TVariablesAdd> {
    config = this.initializeConfig(config);
    const opDefs = this.document.definitions.concat(document.definitions).filter((def: DefinitionNode): def is OperationDefinitionNode => def.kind === 'OperationDefinition')
    if (!opDefs.length) {
      throw new CombinedQueryError('Expected at least one OperationDefinition, but found none.')
    }

    // do some basic validation
    opDefs.forEach(def => {

      const otherOpDefs = opDefs.filter(_def => _def !== def)

      // all op defs must be of the same type
      otherOpDefs.forEach(_def => {
        if (_def.operation !== def.operation) {
          throw new CombinedQueryError(`expected all operations to be of the same type, but ${_def.name?.value} is ${_def.operation} and ${def.name?.value} is ${def.operation}`)
        }
      })

      // all top level fields mut be unique. doesn't drill down fragments tho. maybe someday
      def.selectionSet.selections?.filter((s): s is FieldNode => s.kind === 'Field').forEach(sel => {
        otherOpDefs.forEach(_def => _def.selectionSet.selections?.filter((s): s is FieldNode => s.kind === 'Field').forEach(_sel => {
          if ((sel.alias?.value || sel.name.value) === (_sel.alias?.value || _sel.name.value)) {
            throw new CombinedQueryError(`duplicate field definition ${_sel.name.value} for operations ${def.name?.value} and ${_def.name?.value}`)
          }
        }))
      })

      // finally all variables must be unique
      def.variableDefinitions?.forEach(variable => {
        otherOpDefs.forEach(_def => _def.variableDefinitions?.forEach(_variable => {
          if (!config?.allow_duplicates?.includes(variable.variable.name.value) && variable.variable.name.value === _variable.variable.name.value) {
            throw new CombinedQueryError(`duplicate variable definition ${_variable.variable.name.value} for operations ${def.name?.value} and ${_def.name?.value}`)
          }
        }))
      })
    })

    const newVars: TVariables & TVariablesAdd = (() => {
      if (this.variables && variables) {
        return {
          ...this.variables,
          ...variables
        } as TVariables & TVariablesAdd
      }
      return (variables || this.variables) as TVariables & TVariablesAdd
    })()

    let definitions: DefinitionNode[] = [{
      kind: 'OperationDefinition',
      directives: opDefs.flatMap(def => def.directives || []),
      name: { kind: 'Name', value: this.operationName },
      operation: opDefs[0].operation,
      selectionSet: {
        kind: 'SelectionSet',
        selections: opDefs.flatMap(def => def.selectionSet.selections)
      },
      variableDefinitions: opDefs.flatMap(def => def.variableDefinitions || [])
    }]
    const encounteredFragmentList = new Set<string>()
    const combinedDocumentDefinitions = this.document.definitions.concat(document.definitions)
    for (const definition of combinedDocumentDefinitions) {
      if (definition.kind === 'OperationDefinition') {
        continue
      }
      if (definition.kind === 'FragmentDefinition') {
        if (encounteredFragmentList.has(definition.name.value)) {
          continue
        }
        encounteredFragmentList.add(definition.name.value)
      }
      definitions = [definition, ...definitions]
    }

    const newDoc: DocumentNode = {
      kind: 'Document',
      definitions
    }

    return new CombinedQueryBuilderImpl<TData & TDataAdd, TVariables & TVariablesAdd>(this.operationName, newDoc, newVars)
  }

  addN<TVariablesAdd = OperationVariables>(document: DocumentNode, variables: TVariablesAdd[], variableRenameFn: RenameFnWithIndex = defaultRenameFn, fieldRenameFn: RenameFnWithIndex = defaultRenameFn): CombinedQueryBuilder<TData, TVariables> {
    if (!variables.length) {
      return this
    }
    return variables.reduce<CombinedQueryBuilder<unknown, TVariables & OperationVariables>>((builder, _variables, idx): CombinedQueryBuilder<unknown, TVariables & OperationVariables> => {
      const doc = renameVariablesAndTopLevelFields(document, name => variableRenameFn(name, idx), name => fieldRenameFn(name, idx))
      const vars = renameVariables(_variables, name => variableRenameFn(name, idx))
      return builder.add(doc, vars as any)
    }, this)
  }
}

export default function combinedQuery(operationName: string, config?: CombinedQueryBuilderConfig): NewCombinedQueryBuilder {
  let defaultConfig = config;
  
  return {
    operationName,
    add<TData = any, TVariables extends OperationVariables={}>(document: DocumentNode, variables?: TVariables, config?: CombinedQueryBuilderConfig) {
      return new CombinedQueryBuilderImpl<TData, TVariables>(this.operationName, document, variables, defaultConfig ?? config)
    },
    addN<TVariables = OperationVariables>(document: DocumentNode, variables: TVariables[], variableRenameFn?: RenameFnWithIndex, fieldRenameFn?: RenameFnWithIndex): CombinedQueryBuilder<{}, {}> {
      return new CombinedQueryBuilderImpl<{}, {}>(this.operationName,  emptyDoc).addN<TVariables>(document, variables, variableRenameFn, fieldRenameFn)
    }
  }
}
