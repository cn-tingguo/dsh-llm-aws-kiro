window.__ModuleLoader__.load({
	id: "dsh-llm-kiro-local",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region client/KiroModelCostLabel.module.css
		const css = ".kiroCostLabel_label{vertical-align:baseline;white-space:nowrap;align-items:center;gap:4px;display:inline-flex}.kiroCostLabel_tag{vertical-align:baseline;white-space:nowrap;align-items:center;justify-content:center;display:inline-flex;padding:0 6px;border-radius:999px;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}";
		const tagId = "dsh-llm-kiro-local/KiroModelCostLabel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-llm-kiro-local";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var KiroModelCostLabel_module_css_default = { "label": "kiroCostLabel_label", "tag": "kiroCostLabel_tag" };
		//#endregion
		//#region client/KiroModelCostLabel.js
		/**
		 * The description the Kiro provider publishes for a priced model.
		 * Shape: "<multiplier>x credit"; anything else is left untouched.
		 */
		const COST_PATTERN = /^(\d+(?:\.\d+)?)x credit$/;
		/**
		 * Read the credit multiplier out of a catalog entry's description.
		 * @param description - the entry's description, if any.
		 * @returns the multiplier text such as "1.3x", or undefined.
		 */
		function costOf(description) {
			if (typeof description !== "string") return undefined;
			const match = COST_PATTERN.exec(description.trim());
			return match === null ? undefined : `${match[1]}x`;
		}
		/**
		 * Render the model label with its credit multiplier beside the name.
		 * @param props - provider and model identity plus the badge dictionary.
		 * @returns The decorated label, or the untouched catalog name.
		 */
		function KiroModelCostLabel({ model, t }) {
			const cost = costOf(model.description);
			if (cost === undefined) return model.name;
			return (0, react_jsx_runtime.jsxs)("span", {
				className: KiroModelCostLabel_module_css_default.label,
				children: [
					(0, react_jsx_runtime.jsx)("span", { children: model.name }),
					" ",
					(0, react_jsx_runtime.jsx)("span", {
						className: KiroModelCostLabel_module_css_default.tag,
						"data-tone": "info",
						title: t("badge.cost"),
						children: cost
					})
				]
			});
		}
		//#endregion
		//#region client/locales.js
		/** Simplified Chinese badge copy. */
		const zh = { "badge.cost": "倍率" };
		/** English badge copy. */
		const en = { "badge.cost": "credit" };
		//#endregion
		//#region client/index.js
		/** Required services: model-label registration and localized badge text. */
		const inject = ["slots", "locale"];
		/**
		 * Decorate existing model labels while their declaring slot is mounted.
		 * @param ctx - Client plugin context owning the dictionaries and registration.
		 */
		function apply(ctx) {
			const namespace = "kiro-model-cost";
			ctx.effect(() => ctx.locale.register(namespace, {
				zh,
				en
			}), "kiro-model-cost: dictionaries");
			ctx.slots.inject("conversation.input.model.label", () => ctx.slots.register({
				name: "conversation.input.model.label",
				locale: namespace
			}, KiroModelCostLabel));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
