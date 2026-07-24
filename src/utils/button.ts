import type { ButtonComponent } from "obsidian";

export function setDestructiveButton(button: ButtonComponent): ButtonComponent {
	if (typeof button.setDestructive === "function") {
		return button.setDestructive();
	}

	button.buttonEl.addClass("mod-warning");
	return button;
}
