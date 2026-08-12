# Copyright (c) 2026, Dinext and contributors
# For license information, please see license.txt

"""Install / migrate hooks for Dinext Risk Management."""

from dinext_risk_management.setup.dinext_hub import register_dinext_hub_items


def after_install() -> None:
	register_dinext_hub_items()


def after_migrate() -> None:
	register_dinext_hub_items()
