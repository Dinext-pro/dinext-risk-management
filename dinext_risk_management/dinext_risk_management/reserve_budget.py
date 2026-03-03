# Copyright (c) 2026, Dinext and contributors
# For license information, please see license.txt

"""Reserve calculation and Project Budget update."""

import json
from datetime import date
import frappe
from frappe.utils import getdate, add_to_date

def _periods_month(start_date, end_date):
	from dateutil.relativedelta import relativedelta
	start = getdate(start_date)
	end = getdate(end_date)
	cur = start.replace(day=1)
	while cur <= end:
		yield (cur.year, cur.month)
		cur += relativedelta(months=1)


def _periods_quarter(start_date, end_date):
	seen = set()
	for y, m in _periods_month(start_date, end_date):
		q = (y, (m - 1) // 3 + 1)
		if q in seen:
			continue
		seen.add(q)
		yield (y, q[1] * 3)


def _periods_year(start_date, end_date):
	seen_y = set()
	for y, m in _periods_month(start_date, end_date):
		if y in seen_y:
			continue
		seen_y.add(y)
		yield (y, 12)


def get_periods_for_reserve(reserve_period, start_date, end_date):
	if not start_date or not end_date:
		frappe.log("get_periods_for_reserve: no start_date or end_date")
		return []
	start = getdate(start_date)
	end = getdate(end_date)
	if start > end:
		frappe.log("get_periods_for_reserve: start > end")
		return []
	if reserve_period == "Месяц":
		periods = list(_periods_month(start, end))
	elif reserve_period == "Квартал":
		periods = list(_periods_quarter(start, end))
	elif reserve_period == "Год":
		periods = list(_periods_year(start, end))
	elif reserve_period in ("Проект / Задача", "Проект", "Задача"):
		periods = [(end.year, end.month)]
	else:
		periods = list(_periods_month(start, end))
	frappe.log("get_periods_for_reserve period=%s start=%s end=%s -> %s periods" % (reserve_period, start, end, len(periods)))
	return periods


def get_reserve_amount_for_period(row):
	method = (row.get("reserve_method") or "").strip()
	if method == "Сумма":
		return float(row.get("reserve_amount") or 0)
	return 0.0


def account_has_task_dimension(account, company):
	if not account or not company:
		return False
	try:
		filters = frappe.get_all(
			"Accounting Dimension Filter",
			filters={"company": company, "disabled": 0},
			fields=["name"],
		)
		for f in filters:
			doc = frappe.get_cached_doc("Accounting Dimension Filter", f.name)
			dimension = getattr(doc, "accounting_dimension", None) or doc.get("accounting_dimension")
			if dimension and frappe.db.get_value("Accounting Dimension", dimension, "document_type") == "Task":
				accounts = doc.get("accounts") or []
				for acc in accounts:
					if (getattr(acc, "applicable_on_account", None) or acc.get("applicable_on_account")) == account:
						frappe.log("account_has_task_dimension: account=%s company=%s -> Task applicable" % (account, company))
						return True
	except Exception as e:
		frappe.log("account_has_task_dimension: account=%s company=%s error=%s" % (account, company, e))
	return False


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


def add_reserve_to_budget(project, account, dimensions, periods, amount_per_period, company):
	if not periods or amount_per_period <= 0:
		frappe.log("add_reserve_to_budget: skip (no periods or amount<=0)")
		return
	existing = find_project_budget(project, account, dimensions)
	if existing:
		doc = frappe.get_doc("Project Budget", existing)
		frappe.log("add_reserve_to_budget: update existing Project Budget name=%s project=%s account=%s dims=%s periods=%s amount=%s"
			% (existing, project, account, dimensions_key(dimensions), len(periods), amount_per_period))
	else:
		frappe.has_permission("Project Budget", "create", throw=True)
		doc = frappe.new_doc("Project Budget")
		doc.pb_project = project
		doc.pb_account = account
		for d in dimensions:
			doc.append("project_budget_dimension", {"doc": d["doc"], "docname": d["docname"]})
		frappe.log("add_reserve_to_budget: create new Project Budget project=%s account=%s dims=%s periods=%s amount=%s"
			% (project, account, dimensions_key(dimensions), len(periods), amount_per_period))
	amount_map = {}
	existing_plan = {}

	for row in doc.get("project_budget_amount") or []:
		fy_val = row.pba_year
		if fy_val is None:
			continue
		key = (fy_val, row.pba_month)
		amount_map[key] = float(row.pba_expected or 0)
		existing_plan[key] = row.pba_plan
		amount_map[key] = amount_per_period

	doc.project_budget_amount = []
	for (fy, month), value in sorted(amount_map.items(), key=lambda x: (x[0][0], x[0][1])):
		plan = existing_plan.get((fy, month), 0)
		doc.append("project_budget_amount", {
			"pba_year": fy, "pba_month": month, "pba_plan": plan, "pba_expected": value
		})		
	doc.save()
	frappe.log("add_reserve_to_budget: saved Project Budget name=%s" % (doc.name,))


@frappe.whitelist()
def calculate_reserve_and_update_budget(project, selected_source_names):
	frappe.log("_________________ Calculate Risk Reserve & Update Project Budget _________________")
	frappe.log("calculate_reserve_and_update_budget: start project=%s selected_source_names=%s" % (project, selected_source_names))
	frappe.has_permission("Project Budget", "write", throw=True)
	if isinstance(selected_source_names, str):
		selected_source_names = json.loads(selected_source_names)

	if not project or not selected_source_names:
		frappe.log("calculate_reserve_and_update_budget: no project or no risks selected")
		return {"message": "No project or no risks selected", "updated": 0 }
	project_doc = frappe.get_doc("Project", project)
	company = project_doc.get("company") or frappe.defaults.get_default("company")
	start_date = project_doc.get("expected_start_date") or getdate()
	end_date = project_doc.get("expected_end_date") or add_to_date(getdate(), months=12)
	risks = project_doc.get("custom_project_risks") or []
	frappe.log("calculate_reserve_and_update_budget: project=%s company=%s start=%s end=%s risks_count=%s"
		% (project, company, start_date, end_date, len(risks)))
	if not risks:
		frappe.log("calculate_reserve_and_update_budget: no risks on project %s" % (project,))
		return {"message": "No risks on project", "updated": 0 }
	updated = 0
	for name in selected_source_names:
		#row = risks[idx]
		row = next((x for x in risks if x.get("name") == name), None)
		if not row.get("contingency_reserve") or row.get("status") == "Closed":
			frappe.log("calculate_reserve_and_update_budget: skip name=%s contingency_reserve=%s status=%s"
				% (name, row.get("contingency_reserve"), row.get("status")))
			continue
		reserve_account = (row.get("reserve_account") or "").strip()
		reserve_period = (row.get("reserve_period") or "Месяц").strip()
		if not reserve_account:
			frappe.log("calculate_reserve_and_update_budget: skip name=%s no reserve_account" % (name,))
			continue
		amount_per_period = get_reserve_amount_for_period(row)
		if amount_per_period <= 0:
			frappe.log("calculate_reserve_and_update_budget: skip name=%s amount_per_period<=0 (method=%s)"
				% (name, row.get("reserve_method")))
			continue
		dimensions = [{"doc": "Project Risk", "docname": row.get("name") or str(name)}]
		if row.get("task") and account_has_task_dimension(reserve_account, company):
			dimensions.append({"doc": "Task", "docname": row.get("task")})
		periods = get_periods_for_reserve(reserve_period, start_date, end_date)
		if not periods:
			frappe.log("calculate_reserve_and_update_budget: skip name=%s no periods for reserve_period=%s" % (name, reserve_period))
			continue
		frappe.log("calculate_reserve_and_update_budget: process risk row_name=%s account=%s period=%s periods=%s amount=%s"
			% (row.get("name"), reserve_account, reserve_period, len(periods), amount_per_period))
		add_reserve_to_budget(project, reserve_account, dimensions, periods, amount_per_period, company)
		updated += 1
	frappe.log("calculate_reserve_and_update_budget: done project=%s updated=%s" % (project, updated))
	return {"message": "OK", "updated": updated}