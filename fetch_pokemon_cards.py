#!/usr/bin/env python3
"""
Fetch all Pokémon TCG cards and create a formatted Excel spreadsheet.
Run this script on a machine with internet access to fetch data from the Pokémon TCG API.
"""

import requests
import json
import time
from urllib.parse import quote
import re
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
import os

def make_slug(name):
    """Convert card name to PriceCharting slug format"""
    if not name:
        return ""
    slug = name.lower()
    slug = re.sub(r'[^a-z0-9\s\-]', '', slug)
    slug = re.sub(r'\s+', '-', slug.strip())
    slug = re.sub(r'-+', '-', slug)
    return slug.strip('-')

def fetch_pokemon_cards():
    """Fetch all cards from Pokémon TCG API"""
    all_cards = []
    page_size = 250
    page = 0
    base_url = "https://api.pokemontcg.io/v2/cards"

    print("Fetching Pokémon TCG cards...")

    while page < 70:
        params = {
            "pageSize": page_size,
            "page": page
        }

        try:
            response = requests.get(base_url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            cards = data.get("data", [])
            if not cards:
                print(f"Page {page}: No more cards. Total fetched: {len(all_cards)}")
                break

            all_cards.extend(cards)
            print(f"Page {page}: Fetched {len(cards)} cards. Running total: {len(all_cards)}")

            page += 1
            time.sleep(0.1)

        except Exception as e:
            print(f"Error on page {page}: {e}")
            break

    return all_cards

def create_excel(cards, output_path):
    """Create formatted Excel file with card data"""
    rows = []

    for card in cards:
        name = card.get("name", "")
        set_info = card.get("set", {})
        set_name = set_info.get("name", "")
        set_code = set_info.get("id", "")
        card_number = card.get("number", "")
        rarity = card.get("rarity", "")
        supertype = card.get("supertype", "")

        tcgplayer_url = card.get("tcgplayer", {}).get("url", "")

        images = card.get("images", {})
        image_url = images.get("small", "")

        slug = make_slug(name)
        pricecharting_url = f"https://www.pricecharting.com/game/pokemon/{slug}"
        search_url = f"https://www.pricecharting.com/search-products?q={quote(name)}&type=prices"

        rows.append([
            name,
            set_name,
            set_code,
            card_number,
            rarity,
            supertype,
            pricecharting_url,
            search_url,
            tcgplayer_url,
            image_url
        ])

    rows.sort(key=lambda x: (x[2], x[3] if x[3] else ""))

    print(f"\nCreating Excel file with {len(rows)} cards...")

    wb = Workbook()
    sheet = wb.active
    sheet.title = "Pokemon Cards"

    headers = [
        "Card Name",
        "Set Name",
        "Set Code",
        "Card Number",
        "Rarity",
        "Supertype",
        "PriceCharting URL",
        "PriceCharting Search URL",
        "TCGPlayer URL",
        "Card Image URL"
    ]

    sheet.append(headers)

    header_font = Font(name='Arial', size=9, bold=True, color='FFFFFF')
    header_fill = PatternFill(start_color='2D2D2D', end_color='2D2D2D', fill_type='solid')
    header_alignment = Alignment(horizontal='left', vertical='center', wrap_text=True)

    for col_num, header in enumerate(headers, 1):
        cell = sheet.cell(row=1, column=col_num)
        cell.value = header
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_alignment

    sheet.row_dimensions[1].height = 20

    data_font = Font(name='Arial', size=9)
    white_fill = PatternFill(start_color='FFFFFF', end_color='FFFFFF', fill_type='solid')
    gray_fill = PatternFill(start_color='F5F5F5', end_color='F5F5F5', fill_type='solid')

    for row_idx, row_data in enumerate(rows, 2):
        fill = gray_fill if row_idx % 2 == 0 else white_fill
        for col_idx, value in enumerate(row_data, 1):
            cell = sheet.cell(row=row_idx, column=col_idx)
            cell.value = value
            cell.font = data_font
            cell.fill = fill
            cell.alignment = Alignment(horizontal='left', vertical='top', wrap_text=False)

    widths = [30, 28, 10, 8, 18, 12, 55, 55, 55, 55]
    for col_idx, width in enumerate(widths, 1):
        sheet.column_dimensions[get_column_letter(col_idx)].width = width

    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    wb.save(output_path)

    print(f"Excel file saved to: {output_path}")
    print(f"Total rows: {len(rows)}")

if __name__ == "__main__":
    import sys
    output_path = sys.argv[1] if len(sys.argv) > 1 else 'pokemon_cards_pricechart.xlsx'
    cards = fetch_pokemon_cards()
    if cards:
        create_excel(cards, output_path)
    else:
        print("No cards fetched. Check your internet connection and API access.")
