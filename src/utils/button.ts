import type { ButtonComponent } from "obsidian";

export function setDestructiveButton(button: ButtonComponent): ButtonComponent {
	const setDestructive: unknown = Reflect.get(button, "setDestructive");

	if (typeof setDestructive === "function") {
		setDestructive.call(button);
		return button;
	}

	button.buttonEl.addClass("mod-warning");
	return button;
}
