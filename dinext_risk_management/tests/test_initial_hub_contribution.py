from dinext_common.tests.hub_test_utils import HubRegistrationTestCase
from dinext_risk_management.setup.dinext_hub import register_dinext_hub_items


class TestInitialHubContribution(HubRegistrationTestCase):
	def test_initial_registration_adds_no_cards(self):
		register_dinext_hub_items()
		register_dinext_hub_items()
		self.settings.reload()
		self.assertEqual(self.settings.items, [])

	def test_existing_card_is_preserved(self):
		self.settings.append("items", {
			"section": "Custom", "element_type": "URL", "target": "https://example.com",
			"label": "Existing administrator card", "source_app": "dinext_risk_management", "enabled": 0,
		})
		self.settings.save(ignore_permissions=True)
		register_dinext_hub_items()
		self.settings.reload()
		self.assertEqual(len(self.settings.items), 1)
		self.assertEqual(self.settings.items[0].label, "Existing administrator card")
		self.assertFalse(self.settings.items[0].enabled)
