"""States, House apportionment, and which offices are on the 2026 ballot.

House seats: 2020 apportionment (435). Senate: the 33 Class II seats plus special
elections in Ohio and Florida (35). Governors: the 36 regular 2026 races.
Tile grid x/y positions place states roughly geographically for the House tile map.
"""

# abbr, name, FIPS, House seats, tile x, tile y
STATES = [
    ("AL", "Alabama", "01", 7, 7, 6), ("AK", "Alaska", "02", 1, 0, 0), ("AZ", "Arizona", "04", 9, 2, 5),
    ("AR", "Arkansas", "05", 4, 5, 5), ("CA", "California", "06", 52, 1, 4), ("CO", "Colorado", "08", 8, 3, 4),
    ("CT", "Connecticut", "09", 5, 10, 3), ("DE", "Delaware", "10", 1, 10, 4), ("FL", "Florida", "12", 28, 9, 7),
    ("GA", "Georgia", "13", 14, 8, 6), ("HI", "Hawaii", "15", 2, 0, 7), ("ID", "Idaho", "16", 2, 2, 2),
    ("IL", "Illinois", "17", 17, 6, 2), ("IN", "Indiana", "18", 9, 6, 3), ("IA", "Iowa", "19", 4, 5, 3),
    ("KS", "Kansas", "20", 4, 4, 5), ("KY", "Kentucky", "21", 6, 6, 4), ("LA", "Louisiana", "22", 6, 5, 6),
    ("ME", "Maine", "23", 2, 11, 0), ("MD", "Maryland", "24", 8, 9, 4), ("MA", "Massachusetts", "25", 9, 11, 2),
    ("MI", "Michigan", "26", 13, 8, 2), ("MN", "Minnesota", "27", 8, 5, 2), ("MS", "Mississippi", "28", 4, 6, 6),
    ("MO", "Missouri", "29", 8, 5, 4), ("MT", "Montana", "30", 2, 3, 2), ("NE", "Nebraska", "31", 3, 4, 4),
    ("NV", "Nevada", "32", 4, 2, 3), ("NH", "New Hampshire", "33", 2, 11, 1), ("NJ", "New Jersey", "34", 12, 9, 3),
    ("NM", "New Mexico", "35", 3, 3, 5), ("NY", "New York", "36", 26, 9, 2), ("NC", "North Carolina", "37", 14, 7, 5),
    ("ND", "North Dakota", "38", 1, 4, 2), ("OH", "Ohio", "39", 15, 7, 3), ("OK", "Oklahoma", "40", 5, 4, 6),
    ("OR", "Oregon", "41", 6, 1, 3), ("PA", "Pennsylvania", "42", 17, 8, 3), ("RI", "Rhode Island", "44", 2, 10, 2),
    ("SC", "South Carolina", "45", 7, 8, 5), ("SD", "South Dakota", "46", 1, 4, 3), ("TN", "Tennessee", "47", 9, 6, 5),
    ("TX", "Texas", "48", 38, 4, 7), ("UT", "Utah", "49", 4, 2, 4), ("VT", "Vermont", "50", 1, 10, 1),
    ("VA", "Virginia", "51", 11, 8, 4), ("WA", "Washington", "53", 10, 1, 2), ("WV", "West Virginia", "54", 2, 7, 4),
    ("WI", "Wisconsin", "55", 8, 7, 2), ("WY", "Wyoming", "56", 1, 3, 3),
]
BY_ABBR = {s[0]: s for s in STATES}

SENATE_2026 = ["AL", "AK", "AR", "CO", "DE", "FL", "GA", "ID", "IL", "IA", "KS", "KY", "LA", "ME", "MA", "MI",
               "MN", "MS", "MT", "NE", "NH", "NJ", "NM", "NC", "OH", "OK", "OR", "RI", "SC", "SD", "TN", "TX",
               "VA", "WV", "WY"]
SENATE_SPECIAL = {"OH", "FL"}
GOVERNOR_2026 = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "FL", "GA", "HI", "ID", "IL", "IA", "KS", "ME", "MD",
                 "MA", "MI", "MN", "NE", "NV", "NH", "NM", "NY", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
                 "TX", "VT", "WI", "WY"]

assert sum(s[3] for s in STATES) == 435
assert len(SENATE_2026) == 35 and len(GOVERNOR_2026) == 36


def house_districts():
    for abbr, name, _fips, seats, *_ in STATES:
        for n in range(1, seats + 1):
            yield abbr, name, n, seats == 1


def state_table():
    """Compact table shipped to the page for the maps."""
    return [{"abbr": a, "name": n, "fips": f, "seats": s, "x": x, "y": y} for a, n, f, s, x, y in STATES]
