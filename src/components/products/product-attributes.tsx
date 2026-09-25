import type { IconComponent } from "@/types";

interface AttributeItem {
  id: string;
  label: string;
  value: string;
  icon: IconComponent;
}

interface ProductAttributesProps {
  items: AttributeItem[];
}

/** 商品基础属性列表 */
export function ProductAttributes({ items }: ProductAttributesProps) {
  return (
    <dl className="flex flex-col">
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <div
            key={item.id}
            className={
              index === 0
                ? "flex items-start gap-3 py-2.5"
                : "flex items-start gap-3 border-t border-border/70 py-2.5"
            }
          >
            <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <dt className="w-20 shrink-0 text-[12px] text-muted-foreground">
              {item.label}
            </dt>
            <dd className="min-w-0 flex-1 text-[12px] leading-5 font-medium">
              {item.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
