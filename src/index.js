// @flow
import React from 'react'
import PropTypes from 'prop-types'
import hoist from 'hoist-non-react-statics'
import { Context } from 'vm'
import req from './requireUniversalModule'

import type {
  Config,
  ConfigFunc,
  ComponentOptions,
  RequireAsync,
  State,
  Props
} from './flowTypes'

import {
  DefaultLoading,
  DefaultError,
  createDefaultRender,
  isServer
} from './utils'

export { CHUNK_NAMES, MODULE_IDS } from './requireUniversalModule'
export { default as ReportChunks } from './report-chunks'

let hasBabelPlugin = false

const isHMR = () =>
  // $FlowIgnore
  module.hot && (module.hot.data || module.hot.status() === 'apply')

export const setHasBabelPlugin = () => {
  hasBabelPlugin = true
}

export default function universal<Props: Props>(
  asyncModule: Config | ConfigFunc,
  opts: ComponentOptions = {}
) {
  const {
    render: userRender,
    loading: Loading = DefaultLoading,
    error: Err = DefaultError,
    minDelay = 0,
    alwaysDelay = false,
    testBabelPlugin = false,
    loadingTransition = true,
    ...options
  } = opts

  const render = userRender || createDefaultRender(Loading, Err)

  const isDynamic = hasBabelPlugin || testBabelPlugin
  options.isDynamic = isDynamic
  options.usesBabelPlugin = hasBabelPlugin
  options.modCache = {}
  options.promCache = {}

  return class UniversalComponent extends React.Component<void, Props, *> {
    /* eslint-disable react/sort-comp */
    _initialized: boolean
    _asyncOnly: boolean

    state: State
    props: Props
    context: Object
    /* eslint-enable react/sort-comp */

    static preload(props: Props, context: Object = {}) {
      props = props || {}
      const { requireAsync, requireSync } = req(asyncModule, options, props)
      let mod

      try {
        mod = requireSync(props, context)
      }
      catch (error) {
        return Promise.reject(error)
      }

      return Promise.resolve()
        .then(() => {
          if (mod) return mod
          return requireAsync(props, context)
        })
        .then(mod => {
          hoist(UniversalComponent, mod, {
            preload: true,
            preloadWeak: true
          })
          return mod
        })
    }

    static preloadWeak(props: Props, context: Object = {}) {
      props = props || {}
      const { requireSync } = req(asyncModule, options, props)

      const mod = requireSync(props, context)
      if (mod) {
        hoist(UniversalComponent, mod, {
          preload: true,
          preloadWeak: true
        })
      }

      return mod
    }

    static contextTypes = {
      store: PropTypes.object,
      report: PropTypes.func
    }

    static handleBeforeStatic = (
      isMount: boolean,
      isSync: boolean,
      isServer?: boolean = false
    ) => constructor.handleBefore

    static requireAsyncStatic = (
      requireAsync: RequireAsync,
      props: Props,
      state: State,
      context: Context,
      isMount?: boolean
    ) => constructor.requireAsyncInner

    constructor(props: Props, context: {}) {
      super(props, context)
      this.state = this.init(this.props, this.context)
    }

    static getDerivedStateFromProps(nextProps, currentState) {
      const { props: prevProps, context, mod: prevMod } = currentState

      let mod = prevMod

      if (prevProps && (isDynamic || currentState.asyncOnly)) {
        const { requireSync, requireAsync, shouldUpdate } = req(
          asyncModule,
          options,
          nextProps,
          prevProps
        )

        if (shouldUpdate(nextProps, prevProps)) {
          try {
            mod = requireSync(nextProps, context)
          }
          catch (error) {
            return { props: nextProps, context, mod, error }
          }

          UniversalComponent.handleBeforeStatic(false, !!mod)

          if (!mod) {
            UniversalComponent.requireAsyncStatic(
              requireAsync,
              nextProps,
              { props: nextProps, context },
              context
            )
            return { props: nextProps, context }
          }
          let nextState
          // TODO: раскомментировать и реализовать
          if (alwaysDelay) {
            if (loadingTransition) {
              return this.__update({ mod: null, props: nextProps, context })
            } // display `loading` during componentWillReceiveProps

            const getNewState = () =>
              UniversalComponent.__update(
                { mod, props: nextProps, context },
                false,
                true
              )
            setTimeout(() => (nextState = getNewState()), minDelay)
            return nextState
          }

          nextState = UniversalComponent.__update(
            { mod, props: nextProps, context },
            false,
            true
          )
          return nextState
        }
        else if (isHMR()) {
          mod = requireSync(nextProps, context)
        }
      }
      return {
        props: nextProps,
        mod,
        context
        // context: UniversalComponent.context
      }
    }

    init(props, context) {
      this._initialized = true

      const { addModule, requireSync, requireAsync, asyncOnly } = req(
        asyncModule,
        options,
        props
      )

      let mod

      try {
        mod = requireSync(props, context)
      }
      catch (error) {
        return this.__update({ error, props, context })
      }

      this._asyncOnly = asyncOnly
      const chunkName = addModule(props) // record the module for SSR flushing :)

      if (context.report) {
        context.report(chunkName)
      }

      if (mod || isServer) {
        this.handleBefore(true, true, isServer)
        return this.__update(
          { asyncOnly, props, mod, context },
          true,
          true,
          isServer
        )
      }

      this.handleBefore(true, false)
      this.requireAsyncInner(
        requireAsync,
        props,
        { props, asyncOnly, mod, context },
        context,
        true
      )
      return { mod, asyncOnly, context, props }
    }

    componentWillUnmount() {
      this._initialized = false
    }

    requireAsyncInner(
      requireAsync: RequireAsync,
      props: Props,
      state: State,
      context: Context,
      isMount?: boolean
    ) {
      if (state.mod && loadingTransition) {
        this.update({ mod: null, props }) // display `loading` during componentWillReceiveProps
      }

      const time = new Date()

      requireAsync(props, context)
        .then((mod: ?any) => {
          const state = { mod, props, context }

          const timeLapsed = new Date() - time
          if (timeLapsed < minDelay) {
            const extraDelay = minDelay - timeLapsed
            return setTimeout(() => this.update(state, isMount), extraDelay)
          }

          this.update(state, isMount)
        })
        .catch(error => this.update({ error, props, context }))
    }

    __update = (
      state: State,
      isMount?: boolean = false,
      isSync?: boolean = false,
      isServer?: boolean = false
    ) => {
      if (!this._initialized) return state
      if (!state.error) {
        state.error = null
        return state
      }

      return this.__handleAfter(state, isMount, isSync, isServer)
    }

    __handleAfter(
      state: State,
      isMount: boolean,
      isSync: boolean,
      isServer: boolean
    ) {
      const { mod, error } = state

      if (mod && !error) {
        hoist(UniversalComponent, mod, {
          preload: true,
          preloadWeak: true
        })

        if (this.props.onAfter) {
          const { onAfter } = this.props
          const info = { isMount, isSync, isServer }
          onAfter(info, mod)
        }
      }
      else if (error && this.props.onError) {
        this.props.onError(error)
      }

      return state
    }

    update = (
      state: State,
      isMount?: boolean = false,
      isSync?: boolean = false,
      isServer?: boolean = false
    ) => {
      if (!this._initialized) return
      if (!state.error) state.error = null

      this.handleAfter(state, isMount, isSync, isServer)
    }

    handleBefore(
      isMount: boolean,
      isSync: boolean,
      isServer?: boolean = false
    ) {
      if (this.props.onBefore) {
        const { onBefore } = this.props
        const info = { isMount, isSync, isServer }
        onBefore(info)
      }
    }

    handleAfter(
      state: State,
      isMount: boolean,
      isSync: boolean,
      isServer: boolean
    ) {
      const { mod, error } = state

      if (mod && !error) {
        hoist(UniversalComponent, mod, {
          preload: true,
          preloadWeak: true
        })

        if (this.props.onAfter) {
          const { onAfter } = this.props
          const info = { isMount, isSync, isServer }
          onAfter(info, mod)
        }
      }
      else if (error && this.props.onError) {
        this.props.onError(error)
      }

      this.setState(state)
    }

    render() {
      const { isLoading, error: userError, ...props } = this.props
      const { mod, error } = this.state
      return render(props, mod, isLoading, userError || error)
    }
  }
}
