"""Inventory service: a small, generic stock-keeping module used as a QuSonar demo.

It keeps products and stock levels in memory, records stock movements and answers a few
questions (what to reorder, what the stock is worth). Standard library only.

The section at the end ("Seeded quality issues") is intentionally defective: it holds the
code smells and bugs listed for this file in sonarqube_simulated_issues.xlsx, so QuSonar
has something real to explain and fix. Run this file to see the service work.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class Product:
    sku: str
    name: str
    unit_price: float
    reorder_level: int = 10


@dataclass
class Movement:
    sku: str
    quantity: int            # positive = received, negative = shipped
    reason: str
    at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class InventoryError(ValueError):
    pass


class Inventory:
    """Products, stock levels and the movement history."""

    def __init__(self) -> None:
        self.products: dict[str, Product] = {}
        self.stock: dict[str, int] = {}
        self.history: list[Movement] = []

    def add_product(self, product: Product, opening_stock: int = 0) -> None:
        if product.sku in self.products:
            raise InventoryError(f"Product {product.sku} already exists.")
        if opening_stock < 0:
            raise InventoryError("Opening stock cannot be negative.")
        self.products[product.sku] = product
        self.stock[product.sku] = opening_stock
        if opening_stock:
            self.history.append(Movement(product.sku, opening_stock, "opening stock"))

    def receive(self, sku: str, quantity: int) -> int:
        self._check(sku, quantity)
        self.stock[sku] += quantity
        self.history.append(Movement(sku, quantity, "received"))
        return self.stock[sku]

    def ship(self, sku: str, quantity: int) -> int:
        self._check(sku, quantity)
        if self.stock[sku] < quantity:
            raise InventoryError(f"Only {self.stock[sku]} of {sku} in stock; cannot ship {quantity}.")
        self.stock[sku] -= quantity
        self.history.append(Movement(sku, -quantity, "shipped"))
        return self.stock[sku]

    def to_reorder(self) -> list[str]:
        """SKUs at or below their reorder level, lowest stock first."""
        low = [sku for sku, product in self.products.items() if self.stock[sku] <= product.reorder_level]
        return sorted(low, key=lambda sku: self.stock[sku])

    def stock_value(self) -> float:
        return round(sum(self.stock[sku] * product.unit_price for sku, product in self.products.items()), 2)

    def movements_for(self, sku: str) -> list[Movement]:
        return [movement for movement in self.history if movement.sku == sku]

    def _check(self, sku: str, quantity: int) -> None:
        if sku not in self.products:
            raise InventoryError(f"Unknown product {sku}.")
        if quantity <= 0:
            raise InventoryError("Quantity must be a positive number.")


def demo() -> None:
    inventory = Inventory()
    inventory.add_product(Product("KB-01", "Keyboard", 24.90, reorder_level=5), opening_stock=12)
    inventory.add_product(Product("MS-02", "Mouse", 12.50, reorder_level=8), opening_stock=9)
    inventory.add_product(Product("MN-03", "Monitor", 189.00, reorder_level=2), opening_stock=3)
    inventory.ship("KB-01", 8)
    inventory.ship("MS-02", 2)
    inventory.receive("MN-03", 4)
    print("Stock:", inventory.stock)
    print("Reorder:", inventory.to_reorder())
    print("Stock value:", inventory.stock_value())
    print("Keyboard movements:", len(inventory.movements_for("KB-01")))


# ------------------------------------------------------------------ Seeded quality issues ----
# Synthetic quality-test fixtures. Intentionally defective; not production helpers.
# The companion report lists seeded issues only, not a complete analyzer scan.

def build_stock_query(sku, name, warehouse, location, category, supplier, min_quantity, max_quantity, sort_by, descending, page, page_size, include_archived, currency):
    return {
        "sku": sku,
        "name": name,
        "warehouse": warehouse,
        "location": location,
        "category": category,
        "supplier": supplier,
        "min_quantity": min_quantity,
        "max_quantity": max_quantity,
        "sort_by": sort_by,
        "descending": descending,
        "page": page,
        "page_size": page_size,
        "include_archived": include_archived,
        "currency": currency,
    }


def format_sku_label(sku, legacy_mode):
    return str(sku).strip().upper()


def count_movements(movements):
    debug_snapshot = repr(movements)
    return len(movements)


def sync_timeout(options):
    timeout_seconds = 30
    timeout_seconds = int(options.get("timeout", 60))
    return timeout_seconds


def shipping_plan(mode, order):
    if mode == "express":
        plan = dict(order)
        plan["days"] = 1
        return plan
    elif mode == "priority":
        plan = dict(order)
        plan["days"] = 1
        return plan
    else:
        return {"days": 5, "order": order}


def stock_error_text(kind):
    if kind == "missing":
        return "STOCK_RECORD_NOT_AVAILABLE"
    if kind == "locked":
        return "STOCK_RECORD_NOT_AVAILABLE"
    return "STOCK_RECORD_NOT_AVAILABLE"


def restock_candidates(items):
    selected = []
    for item in items:
        if item.get("active"):
            if item.get("supplier"):
                if item.get("lead_time_days"):
                    if item.get("on_hand", 0) < item.get("reorder_level", 0):
                        if item.get("status") == "approved":
                            selected.append(item)
    return selected


def validate_sku(sku):
    if not sku:
        InventoryError("A SKU is required")
    return {"sku": sku, "valid": True}


def over_capacity(used_slots, capacity):
    if used_slots - used_slots > capacity:
        return True
    return False


def warehouse_routes(primary, fallback):
    routes = {}
    routes["active"] = primary
    routes["active"] = fallback
    return routes


if __name__ == "__main__":
    demo()
