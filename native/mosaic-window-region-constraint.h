// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <glib-object.h>
#include <meta/meta-external-constraint.h>

G_BEGIN_DECLS

#define MOSAIC_TYPE_WINDOW_REGION_CONSTRAINT (mosaic_window_region_constraint_get_type ())
G_DECLARE_FINAL_TYPE (MosaicWindowRegionConstraint,
                      mosaic_window_region_constraint,
                      MOSAIC,
                      WINDOW_REGION_CONSTRAINT,
                      GObject)

MosaicWindowRegionConstraint *mosaic_window_region_constraint_new (void);

void mosaic_window_region_constraint_set_target (MosaicWindowRegionConstraint *self,
                                            int                       x,
                                            int                       y,
                                            int                       width,
                                            int                       height);

G_END_DECLS
