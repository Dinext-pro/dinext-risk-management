# Copyright (c) 2026, Dinext and contributors
# For license information, please see license.txt

"""Reserve calculation and Project Budget update."""

import json
import frappe


def dimensions_key(dimensions):
	if not dimensions:
		return ""
	parts = sorted(f"{d.get('doc')}:{d.get('docname')}" for d in dimensions if d.get("doc"))
	return "|".join(parts)


def find_project_budget(project, account, dimensions):
	budgets = frappe.get_all(
		"Project Budget",
		filters={"pb_project": project, "pb_account": account},
		fields=["name"],
	)
	target_key = dimensions_key(dimensions)
	for b in budgets:
		doc = frappe.get_cached_doc("Project Budget", b.name)
		dims = doc.get("project_budget_dimension") or []
		doc_dims = [{"doc": d.get("doc"), "docname": d.get("docname")} for d in dims]
		if dimensions_key(doc_dims) == target_key:
			frappe.log("find_project_budget: found name=%s project=%s account=%s" % (doc.name, project, account))
			return doc.name
	frappe.log("find_project_budget: not found project=%s account=%s dims=%s" % (project, account, target_key))
	return None


def add_reserve_to_budget(project, account, dimensions, period_amount_map, company, commit=True):
	"""
	Merge reserve amounts into Project Budget. period_amount_map: {(year, month): amount}.
	Only updates the given periods; other existing periods are left unchanged.
	If commit=False, caller is responsible for committing (e.g. batch commit).
	"""
	if not period_amount_map:
		frappe.log("add_reserve_to_budget: skip (no period_amount_map)")
		return
	existing = find_project_budget(project, account, dimensions)
	if existing:
		doc = frappe.get_doc("Project Budget", existing)
		frappe.log("add_reserve_to_budget: update existing Project Budget name=%s project=%s account=%s dims=%s periods=%s"
			% (existing, project, account, dimensions_key(dimensions), len(period_amount_map)))
	else:
		frappe.has_permission("Project Budget", "create", throw=True)
		doc = frappe.new_doc("Project Budget")
		doc.pb_project = project
		doc.pb_account = account
		for d in dimensions:
			doc.append("project_budget_dimension", {"doc": d["doc"], "docname": d["docname"]})
		frappe.log("add_reserve_to_budget: create new Project Budget project=%s account=%s dims=%s periods=%s"
			% (project, account, dimensions_key(dimensions), len(period_amount_map)))
	amount_map = {}
	existing_plan = {}
	for row in doc.get("project_budget_amount") or []:
		if row.pba_year is None:
			continue
		key = (row.pba_year, row.pba_month)
		amount_map[key] = float(row.pba_expected or 0)
		existing_plan[key] = row.pba_plan
	for key, value in period_amount_map.items():
		amount_map[key] = float(value)
		if key not in existing_plan:
			existing_plan[key] = 0
	doc.project_budget_amount = []
	for (fy, month), value in sorted(amount_map.items(), key=lambda x: (x[0][0], x[0][1])):
		plan = existing_plan.get((fy, month), 0)
		doc.append("project_budget_amount", {
			"pba_year": fy, "pba_month": month, "pba_plan": plan, "pba_expected": value
		})
	doc.save()
	if commit:
		frappe.db.commit()
	frappe.log("add_reserve_to_budget: saved Project Budget name=%s" % (doc.name,))


def _parse_period_amount_map(period_amount_map):
	"""
	Convert frontend format {"Y_M": amount} to {(year, month): amount}.
	Keys can be "2026_3" or "2026_12".
	"""
	if not period_amount_map:
		return {}
	out = {}
	for key, value in period_amount_map.items():
		if isinstance(key, str) and "_" in key:
			parts = key.split("_", 1)
			try:
				y, m = int(parts[0]), int(parts[1])
				out[(y, m)] = float(value or 0)
			except (ValueError, IndexError):
				continue
	return out


@frappe.whitelist()
def bulk_save_reserve_budgets(project, updates):
	"""
	Save prepared Project Budget updates from frontend.
	updates: list of { "account", "dimensions": [{"doc", "docname"}], "period_amount_map": {"Y_M": amount} }.
	"""
	frappe.log("_________________ Bulk Save Reserve Budgets _________________")
	frappe.has_permission("Project Budget", "write", throw=True)
	if not project:
		frappe.log("bulk_save_reserve_budgets: no project")
		return {"message": "No project", "updated": 0}
	if isinstance(updates, str):
		updates = json.loads(updates) if updates else []
	if not updates:
		frappe.log("bulk_save_reserve_budgets: no updates")
		return {"message": "No updates", "updated": 0}
	frappe.log("bulk_save_reserve_budgets: start project=%s updates_count=%s" % (project, len(updates)))
	company = frappe.db.get_value("Project", project, "company") or frappe.defaults.get_default("company")
	updated = 0
	batch_size = 20
	for i, item in enumerate(updates):
		try:
			account = (item.get("account") or "").strip()
			dimensions = item.get("dimensions") or []
			period_amount_map_raw = item.get("period_amount_map") or {}
			period_amount_map = _parse_period_amount_map(period_amount_map_raw)
			if not account or not period_amount_map:
				frappe.log("bulk_save_reserve_budgets: skip index=%s account=%s periods=%s" % (i, account, len(period_amount_map)))
				continue
			dimensions = [{"doc": d.get("doc"), "docname": d.get("docname")} for d in dimensions if d.get("doc")]
			frappe.log("bulk_save_reserve_budgets: process index=%s account=%s dims=%s periods=%s"
				% (i, account, dimensions_key(dimensions), len(period_amount_map)))
			add_reserve_to_budget(project, account, dimensions, period_amount_map, company, commit=False)
			updated += 1
			if updated % batch_size == 0:
				frappe.db.commit()
				frappe.log("bulk_save_reserve_budgets: committed batch at count=%s" % updated)
		except Exception as e:
			frappe.log("bulk_save_reserve_budgets: error index=%s %s" % (i, str(e)))
			frappe.log_error(frappe.get_traceback(), "bulk_save_reserve_budgets")
			# continue with next
	if updated % batch_size != 0 or updated == 0:
		frappe.db.commit()
	frappe.log("bulk_save_reserve_budgets: done project=%s updated=%s" % (project, updated))
	return {"message": "OK", "updated": updated}