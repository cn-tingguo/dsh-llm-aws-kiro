window.__ModuleLoader__.load({
  id: 'dsh-llm-kiro-local',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // Injected builtins: the plain-JavaScript symbols the Client half may use
    // without loading a Harness package as a module.
    const React = require('React')
    const styles = require('styles')

    const NAME = 'kiro-model-cost'

    const zh = { 'badge.cost': '倍率' }
    const en = { 'badge.cost': 'credit' }

    styles.insert(
      '.kiro_model_cost_label{display:inline-flex;align-items:center;gap:4px;vertical-align:baseline;white-space:nowrap}'
      + '.kiro_model_cost_tag{display:inline-flex;align-items:center;justify-content:center;'
      + 'padding:1px 6px;border-radius:999px;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;'
      + 'background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);'
      + 'color:var(--dsw-alias-brand-primary)}',
    )

    /**
     * Split a published description into its multiplier, when it is one.
     * @param description - the catalog entry's description, if any.
     * @returns the multiplier text, for example "1.3x", or undefined.
     */
    function costOf(description) {
      if (typeof description !== 'string') return undefined
      const match = /^(\d+(?:\.\d+)?)x credit$/.exec(description.trim())
      return match === null ? undefined : match[1] + 'x'
    }

    /**
     * Render the model label with its credit cost tag.
     * @param props - provider and model identity plus the locale translator.
     * @returns the decorated label, or the untouched catalog name.
     */
    function KiroModelCostLabel({ model, t }) {
      const cost = costOf(model.description)
      if (cost === undefined) return model.name
      return React.createElement('span', { className: 'kiro_model_cost_label' },
        React.createElement('span', null, model.name),
        ' ',
        React.createElement('span', {
          className: 'kiro_model_cost_tag',
          'data-tone': 'info',
          title: t('badge.cost'),
        }, cost),
      )
    }

    const inject = ['slots', 'locale']

    /**
     * Register the label component while its declaring slot is mounted.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NAME, { zh, en }), 'kiro-model-cost: dictionaries')
      ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
        name: 'conversation.input.model.label',
        locale: NAME,
      }, KiroModelCostLabel))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
