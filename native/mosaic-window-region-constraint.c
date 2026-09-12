// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later

#include "mosaic-window-region-constraint.h"
#include <meta/window.h>

struct _MosaicWindowRegionConstraint
{
  GObject parent_instance;

  MtkRectangle target;
  gboolean has_target;
};

static gboolean
mosaic_window_region_constraint_constrain (MetaExternalConstraint     *constraint,
                                      MetaWindow                 *window,
                                      MetaExternalConstraintInfo *info)
{
  MosaicWindowRegionConstraint *self = MOSAIC_WINDOW_REGION_CONSTRAINT (constraint);

  if (!meta_window_is_maximized (window) || meta_window_is_fullscreen (window))
    return FALSE;

  if (!self->has_target || !info || !info->new_rect)
    return FALSE;

  *info->new_rect = self->target;
  return TRUE;
}

static void
mosaic_external_constraint_iface_init (MetaExternalConstraintInterface *iface)
{
  iface->constrain = mosaic_window_region_constraint_constrain;
}

G_DEFINE_FINAL_TYPE_WITH_CODE (
  MosaicWindowRegionConstraint,
  mosaic_window_region_constraint,
  G_TYPE_OBJECT,
  G_IMPLEMENT_INTERFACE (META_TYPE_EXTERNAL_CONSTRAINT,
                         mosaic_external_constraint_iface_init))

static void
mosaic_window_region_constraint_class_init (MosaicWindowRegionConstraintClass *klass)
{
  (void) klass;
}

static void
mosaic_window_region_constraint_init (MosaicWindowRegionConstraint *self)
{
  self->has_target = FALSE;
}

MosaicWindowRegionConstraint *
mosaic_window_region_constraint_new (void)
{
  return g_object_new (MOSAIC_TYPE_WINDOW_REGION_CONSTRAINT, NULL);
}

/**
 * mosaic_window_region_constraint_set_target:
 * @self: a #MosaicWindowRegionConstraint
 * @x: target frame x coordinate
 * @y: target frame y coordinate
 * @width: target frame width
 * @height: target frame height
 *
 * Updates the frame enforced during Mutter's external-constraint pass.
 */
void
mosaic_window_region_constraint_set_target (MosaicWindowRegionConstraint *self,
                                       int                       x,
                                       int                       y,
                                       int                       width,
                                       int                       height)
{
  g_return_if_fail (MOSAIC_IS_WINDOW_REGION_CONSTRAINT (self));

  self->target = (MtkRectangle) {
    .x = x,
    .y = y,
    .width = MAX (1, width),
    .height = MAX (1, height),
  };
  self->has_target = TRUE;
}
