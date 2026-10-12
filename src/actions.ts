import type { DropdownChoice } from '@companion-module/base'
import type ModuleInstance from './main.js'
import { unitOption } from './feedbacks.js'
import { findUnit, isOn, setPointOf, templateChoices, triggerChoices } from './shstate.js'
import type { ShUnit, ShUnitUpdate } from './smarthome.js'

type NoOptions = Record<string, never>

export type SwitchMode = 'on' | 'off' | 'toggle'
export type AdjustMode = 'set' | 'increase' | 'decrease'
export type SetPointMode = AdjustMode | 'on' | 'off'

export type ActionsSchema = {
	sh_switch: { options: { unit: string; mode: SwitchMode } }
	sh_level: { options: { unit: string; mode: AdjustMode; value: number; switchOn: boolean } }
	sh_color: { options: { unit: string; hue: number; saturation: number; switchOn: boolean } }
	sh_color_temperature: { options: { unit: string; kelvin: number; switchOn: boolean } }
	sh_blind: { options: { unit: string; command: 'moveUp' | 'moveDown' | 'stop' } }
	sh_blind_position: { options: { unit: string; position: number } }
	sh_setpoint: { options: { unit: string; mode: SetPointMode; value: number } }
	sh_boost: { options: { unit: string; mode: SwitchMode; minutes: number } }
	sh_window_open: { options: { unit: string; mode: SwitchMode; minutes: number } }
	sh_apply_template: { options: { template: string } }
	sh_trigger: { options: { trigger: string; mode: SwitchMode } }
	wan_reconnect: { options: NoOptions }
	refresh: { options: NoOptions }
}

const SWITCH_MODES: DropdownChoice<SwitchMode>[] = [
	{ id: 'on', label: 'On' },
	{ id: 'off', label: 'Off' },
	{ id: 'toggle', label: 'Toggle' },
]

const ADJUST_MODES: DropdownChoice<AdjustMode>[] = [
	{ id: 'set', label: 'Set to' },
	{ id: 'increase', label: 'Increase by' },
	{ id: 'decrease', label: 'Decrease by' },
]

/** Thermostat setpoints the box accepts: 8 to 28 °C in half degrees. */
export const SETPOINT_MIN = 8
export const SETPOINT_MAX = 28

/**
 * Works out whether the target should end up on.
 * Returns undefined when a toggle was asked for but the current state is unknown.
 */
export function resolveSwitch(mode: SwitchMode, current: boolean | undefined): boolean | undefined {
	if (mode === 'on') return true
	if (mode === 'off') return false
	if (current === undefined) return undefined
	return !current
}

/** Applies a set, increase or decrease to a current value and clamps the result. */
export function adjust(
	mode: AdjustMode,
	current: number | undefined,
	value: number,
	min: number,
	max: number,
): number | undefined {
	let target: number
	if (mode === 'set') target = value
	else if (current === undefined) return undefined
	else target = mode === 'increase' ? current + value : current - value
	return Math.min(max, Math.max(min, target))
}

/** Rounds to the half degree steps a thermostat accepts and keeps the result in range. */
export function clampSetPoint(celsius: number): number {
	return Math.min(SETPOINT_MAX, Math.max(SETPOINT_MIN, Math.round(celsius * 2) / 2))
}

/** The end of a boost or window open period, in unix seconds. The box limits these to a few hours. */
export function endTimeIn(minutes: number, now = Date.now()): number {
	const clamped = Math.min(240, Math.max(1, Math.round(minutes)))
	return Math.floor(now / 1000) + clamped * 60
}

export function UpdateActions(self: ModuleInstance): void {
	const sh = self.smartHome

	/** Looks up the unit an action names and logs why when it cannot be used. */
	const target = (actionName: string, uid: string): ShUnit | undefined => {
		if (!uid) {
			self.log('warn', `${actionName}: no device selected`)
			return undefined
		}
		const unit = findUnit(self.smartHome, uid)
		if (!unit) self.log('warn', `${actionName}: unknown smart home device "${uid}"`)
		return unit
	}

	const putUnit = async (actionName: string, unit: ShUnit, update: ShUnitUpdate): Promise<void> => {
		await self.runSmartHome(`${actionName} ${unit.name}`, async (client) => client.updateUnit(unit.UID, update))
	}

	const timedMode = async (
		actionName: string,
		field: 'boost' | 'windowOpenMode',
		options: { unit: string; mode: SwitchMode; minutes: number },
	): Promise<void> => {
		const unit = target(actionName, options.unit)
		if (!unit) return
		const current = unit.interfaces.thermostatInterface?.[field]?.enabled
		const enable = resolveSwitch(options.mode, current)
		if (enable === undefined) {
			self.log('warn', `${actionName}: cannot toggle ${unit.name}, its current state is unknown`)
			return
		}
		const value = enable ? { enabled: true, endTime: endTimeIn(Number(options.minutes)) } : { enabled: false }
		await putUnit(actionName, unit, { thermostatInterface: { [field]: value } })
	}

	self.setActionDefinitions({
		sh_switch: {
			name: 'Smart home: switch on, off or toggle',
			description: 'Sockets, lamps, switches and switchable groups',
			options: [
				unitOption(sh, 'onOff'),
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Action',
					choices: SWITCH_MODES,
					default: 'toggle',
					disableAutoExpression: true,
				},
			],
			callback: async (action) => {
				const unit = target('Switch', action.options.unit)
				if (!unit) return
				if (unit.interfaces.onOffInterface?.isLockedDeviceApi) {
					self.log('warn', `Switch: ${unit.name} is locked against switching from apps`)
					return
				}
				const on = resolveSwitch(action.options.mode, isOn(unit))
				if (on === undefined) {
					self.log('warn', `Switch: cannot toggle ${unit.name}, its current state is unknown`)
					return
				}
				await putUnit(on ? 'Switch on' : 'Switch off', unit, { onOffInterface: { active: on } })
			},
		},

		sh_level: {
			name: 'Smart home: brightness or level',
			description: 'Dimmable lamps and other level controlled devices, in percent',
			options: [
				unitOption(sh, 'level'),
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Action',
					choices: ADJUST_MODES,
					default: 'set',
					disableAutoExpression: true,
				},
				{ id: 'value', type: 'number', label: 'Percent', default: 50, min: 0, max: 100, range: true },
				{
					id: 'switchOn',
					type: 'checkbox',
					label: 'Also switch on',
					tooltip: 'Changing the level alone does not switch a lamp on',
					default: true,
				},
			],
			callback: async (action) => {
				const unit = target('Level', action.options.unit)
				if (!unit) return
				const level = adjust(
					action.options.mode,
					unit.interfaces.levelControlInterface?.level,
					Number(action.options.value),
					0,
					100,
				)
				if (level === undefined) {
					self.log('warn', `Level: the current level of ${unit.name} is unknown`)
					return
				}
				const update: ShUnitUpdate = { levelControlInterface: { level: Math.round(level) } }
				if (action.options.switchOn && unit.interfaces.onOffInterface) update.onOffInterface = { active: true }
				await putUnit('Level', unit, update)
			},
		},

		sh_color: {
			name: 'Smart home: colour',
			description: 'Colour lamps: hue in degrees and saturation in percent',
			options: [
				unitOption(sh, 'color'),
				{ id: 'hue', type: 'number', label: 'Hue (0-359°)', default: 0, min: 0, max: 359, range: true },
				{ id: 'saturation', type: 'number', label: 'Saturation (%)', default: 100, min: 0, max: 100, range: true },
				{ id: 'switchOn', type: 'checkbox', label: 'Also switch on', default: true },
			],
			callback: async (action) => {
				const unit = target('Colour', action.options.unit)
				if (!unit) return
				const hue = Math.round(Math.min(359, Math.max(0, Number(action.options.hue))))
				// The API takes saturation as 0 to 255; percent is what people think in.
				const saturation = Math.round((Math.min(100, Math.max(0, Number(action.options.saturation))) * 255) / 100)
				const update: ShUnitUpdate = { colorControlInterface: { hsColor: { hue, saturation } } }
				if (action.options.switchOn && unit.interfaces.onOffInterface) update.onOffInterface = { active: true }
				await putUnit('Colour', unit, update)
			},
		},

		sh_color_temperature: {
			name: 'Smart home: colour temperature',
			description: 'White tone of colour lamps in Kelvin',
			options: [
				unitOption(sh, 'color'),
				{ id: 'kelvin', type: 'number', label: 'Kelvin', default: 3000, min: 2700, max: 6500, step: 100, range: true },
				{ id: 'switchOn', type: 'checkbox', label: 'Also switch on', default: true },
			],
			callback: async (action) => {
				const unit = target('Colour temperature', action.options.unit)
				if (!unit) return
				const kelvin = Math.round(Math.min(6500, Math.max(2700, Number(action.options.kelvin))))
				const update: ShUnitUpdate = { colorControlInterface: { colorTemperature: kelvin } }
				if (action.options.switchOn && unit.interfaces.onOffInterface) update.onOffInterface = { active: true }
				await putUnit('Colour temperature', unit, update)
			},
		},

		sh_blind: {
			name: 'Smart home: blind up, down or stop',
			options: [
				unitOption(sh, 'blind'),
				{
					id: 'command',
					type: 'dropdown',
					label: 'Command',
					choices: [
						{ id: 'moveUp', label: 'Up' },
						{ id: 'moveDown', label: 'Down' },
						{ id: 'stop', label: 'Stop' },
					],
					default: 'moveUp',
					disableAutoExpression: true,
				},
			],
			callback: async (action) => {
				const unit = target('Blind', action.options.unit)
				if (!unit) return
				await putUnit('Blind', unit, { blindInterface: { blindAction: action.options.command } })
			},
		},

		sh_blind_position: {
			name: 'Smart home: blind position',
			description: 'Moves a blind to a position in percent',
			options: [
				unitOption(sh, 'blind'),
				{ id: 'position', type: 'number', label: 'Position (%)', default: 50, min: 0, max: 100, range: true },
			],
			callback: async (action) => {
				const unit = target('Blind position', action.options.unit)
				if (!unit) return
				const level = Math.round(Math.min(100, Math.max(0, Number(action.options.position))))
				await putUnit('Blind position', unit, { levelControlInterface: { level } })
			},
		},

		sh_setpoint: {
			name: 'Smart home: thermostat temperature',
			description: 'Sets, raises or lowers the target temperature (8-28 °C), or opens or closes the valve fully',
			options: [
				unitOption(sh, 'thermostat'),
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Action',
					choices: [
						...ADJUST_MODES,
						{ id: 'on', label: 'Valve fully open (ON)' },
						{ id: 'off', label: 'Off / frost protection (OFF)' },
					],
					default: 'set',
					disableAutoExpression: true,
				},
				{
					id: 'value',
					type: 'number',
					label: '°C',
					default: 21,
					min: 0.5,
					max: SETPOINT_MAX,
					step: 0.5,
					isVisibleExpression: `$(options:mode) != 'on' && $(options:mode) != 'off'`,
				},
			],
			callback: async (action) => {
				const unit = target('Thermostat', action.options.unit)
				if (!unit) return
				const mode = action.options.mode
				if (mode === 'on' || mode === 'off') {
					await putUnit(`Thermostat ${mode.toUpperCase()}`, unit, {
						thermostatInterface: { setPointTemperature: { mode } },
					})
					return
				}
				const celsius = adjust(mode, setPointOf(unit), Number(action.options.value), SETPOINT_MIN, SETPOINT_MAX)
				if (celsius === undefined) {
					self.log('warn', `Thermostat: the current target of ${unit.name} is unknown or not a temperature`)
					return
				}
				await putUnit('Thermostat', unit, {
					thermostatInterface: { setPointTemperature: { mode: 'temperature', celsius: clampSetPoint(celsius) } },
				})
			},
		},

		sh_boost: {
			name: 'Smart home: thermostat boost',
			description: 'Opens the valve fully for a while',
			options: [
				unitOption(sh, 'thermostat'),
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Action',
					choices: SWITCH_MODES,
					default: 'toggle',
					disableAutoExpression: true,
				},
				{ id: 'minutes', type: 'number', label: 'Duration (minutes)', default: 30, min: 1, max: 240 },
			],
			callback: async (action) => timedMode('Boost', 'boost', action.options),
		},

		sh_window_open: {
			name: 'Smart home: thermostat window open mode',
			description: 'Closes the valve for a while, as if a window had been opened',
			options: [
				unitOption(sh, 'thermostat'),
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Action',
					choices: SWITCH_MODES,
					default: 'toggle',
					disableAutoExpression: true,
				},
				{ id: 'minutes', type: 'number', label: 'Duration (minutes)', default: 30, min: 1, max: 240 },
			],
			callback: async (action) => timedMode('Window open', 'windowOpenMode', action.options),
		},

		sh_apply_template: {
			name: 'Smart home: apply template or scenario',
			description: 'Runs a template or scenario configured on the box',
			options: [
				{
					id: 'template',
					type: 'dropdown',
					label: 'Template or scenario',
					choices: templateChoices(sh),
					default: String(templateChoices(sh)[0]?.id ?? ''),
					allowCustom: true,
				},
			],
			callback: async (action) => {
				const uid = action.options.template
				if (!uid) {
					self.log('warn', 'Apply template: no template selected')
					return
				}
				const name = self.smartHome.overview.templates.find((template) => template.UID === uid)?.name ?? uid
				await self.runSmartHome(`Apply template ${name}`, async (client) => client.applyTemplate(uid))
			},
		},

		sh_trigger: {
			name: 'Smart home: enable or disable a routine',
			options: [
				{
					id: 'trigger',
					type: 'dropdown',
					label: 'Routine',
					choices: triggerChoices(sh),
					default: String(triggerChoices(sh)[0]?.id ?? ''),
					allowCustom: true,
				},
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Action',
					choices: SWITCH_MODES,
					default: 'toggle',
					disableAutoExpression: true,
				},
			],
			callback: async (action) => {
				const uid = action.options.trigger
				const trigger = self.smartHome.overview.triggers.find((t) => t.UID === uid)
				const enabled = resolveSwitch(action.options.mode, trigger?.enabled)
				if (!uid || enabled === undefined) {
					self.log('warn', `Routine: ${uid ? `the state of ${uid} is unknown` : 'no routine selected'}`)
					return
				}
				await self.runSmartHome(`${enabled ? 'Enable' : 'Disable'} routine ${trigger?.name ?? uid}`, async (client) =>
					client.setTriggerEnabled(uid, enabled),
				)
			},
		},

		wan_reconnect: {
			name: 'Internet: reconnect now',
			description:
				'Drops the internet connection so the box dials in again at once, usually with a new IP address. ' +
				'The internet is gone for a few seconds. Over MyFRITZ! the module loses the box too until the ' +
				'new address has reached the DNS.',
			options: [],
			callback: async () => {
				await self.reconnectWan()
			},
		},

		refresh: {
			name: 'Refresh now',
			description: 'Reads router status and smart home state immediately',
			options: [],
			callback: async () => {
				await self.refreshAll()
			},
		},
	})
}
