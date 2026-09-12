// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <glib-object.h>
#include <meta/meta-external-constraint.h>

G_BEGIN_DECLS

#define MOSAIC_TYPE_DOMINANT_CONSTRAINT (mosaic_dominant_constraint_get_type ())
G_DECLARE_FINAL_TYPE (MosaicDominantConstraint,
                      mosaic_dominant_constraint,
                      MOSAIC,
                      DOMINANT_CONSTRAINT,
                      GObject)

MosaicDominantConstraint *mosaic_dominant_constraint_new (void);

void mosaic_dominant_constraint_set_target (MosaicDominantConstraint *self,
                                            int                       x,
                                            int                       y,
                                            int                       width,
                                            int                       height);

G_END_DECLS
